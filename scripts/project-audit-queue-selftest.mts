import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Header } from "tar";

const directory = await mkdtemp(join(tmpdir(), "audit-queue-"));
Object.assign(process.env, { DATABASE_PATH: join(directory, "test.db"), CURATOR_REVIEWER: "llm", LLM_PROVIDER: "selectel", LLM_MODEL: "fixture",
  SELECTEL_API_KEY: "fixture", INITIAL_OVERVIEW_MODE: "parts", INITIAL_MAP_CONTEXT_TOKENS: "128000", PROJECT_AUDIT_ENABLED: "true",
  GITHUB_APP_ID: "123", GITHUB_WEBHOOK_SECRET: "fixture", TOKENS_PER_DAY: "8000000", TOKENS_PER_PROJECT_DAY: "1500000",
  GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64") });
delete process.env.GITHUB_APP_PRIVATE_KEY_PATH; delete process.env.LLM_FALLBACK_PROVIDER;
const { getDb } = await import("@/lib/db");
const store = await import("@/lib/curator/store");
const auditStore = await import("@/lib/curator/project-audit-store");
const { executeProjectAuditJob, startProjectAudit } = await import("@/lib/curator/project-audit");
const { runJob } = await import("@/lib/curator/worker");
const { pipelineDailyLiability, wakeChangedPipelineJobs } = await import("@/lib/curator/pipeline-job");
const blocks: Buffer[] = [];
for (const [path, content] of [["code.ts", "export const valid = (expiry: number) => expiry < Date.now();\n"], ["data.csv", "CSV_PRIVATE_VALUES"], ["RESEARCH.md", "Expiry must be in the future."]]) {
  const bytes = Buffer.from(content), header = Buffer.alloc(512);
  new Header({ path: "repo/" + path, type: "File", size: bytes.length, mode: 0o600 }).encode(header);
  blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
}
const archive = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
const sha = "a".repeat(40), notes = "### Суть\nTokens\n### Карта репозитория\ncode.ts\n### Путь данных\nнет\n### Сознательные решения\nнет";
let head = sha, searchCalls = 0, verificationCalls = 0, failVerification = false, githubWrites = 0, auditPhase = false;
let historyVerdict = "duplicate", sourceId = "", mapCalls = 0;
let raceOnVerify = false, raceProject = 0;
let unconfirmed = false;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input)), path = url.pathname;
  if (path.endsWith("/installation")) return Response.json({ id: 7 });
  if (path.endsWith("/access_tokens")) return Response.json({ token: "fixture", expires_at: "2099-01-01T00:00:00Z" });
  if (path.endsWith("/repos/sample/project")) return Response.json({ default_branch: "main" });
  if (path.endsWith("/branches/main")) return Response.json({ commit: { sha: head } });
  if (path.includes("/tarball/")) { assert.ok(path.endsWith(sha)); return new Response(new Uint8Array(archive)); }
  if (path.endsWith("/chat/completions")) {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools, undefined);
    const system = String(body.messages[0].content), user = String(body.messages[1].content);
    let value: unknown;
    if (system.includes("при подключении, а не изменения PR")) {
      assert.equal(body.max_tokens, 15000, "project search must send the raised output limit to the provider");
      searchCalls++;
      assert.ok(!user.includes("CSV_PRIVATE_VALUES")); assert.ok(user.includes("Expiry must be in the future"));
      sourceId = /"sourceId":"([^"]+)","path":"code.ts"/.exec(user)![1];
      value = { summary: "Existing expiry issue", unresolved: ["CSV values were intentionally excluded"], findings: [{ title: "Expiry reversed", area: "code", severity: "important", description: "Reversed comparison",
        evidence: "expiry < Date.now()", impact: "Expired tokens accepted", recommendation: "Reverse condition", verify: "Expiration test",
        locations: [{ kind: "file", target: "code.ts", detail: "1" }], source_ids: [sourceId] }] };
    } else if (system.includes("Независимо проверь кандидата")) {
      verificationCalls++;
      if (failVerification) return new Response("unavailable", { status: 503 });
      if (raceOnVerify) { raceOnVerify = false; store.addProjectNotes(raceProject, "Changed supervisor requirement", { actor: "supervisor" }); }
      value = { status: unconfirmed ? "unresolved" : "confirmed", reason: unconfirmed ? "Insufficient evidence for hypothesis" : "Source proves reversed expiry condition" };
    } else if (system.includes("полной историей")) {
      value = { status: historyVerdict, matchingIds: [1], reason: "Same source and cause" };
    } else { mapCalls++; value = { summary: "map", findings: [], notes }; }
    return Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  }
  if (url.host === "api.github.com" && init?.method && init.method !== "GET") {
    githubWrites++; assert.equal(auditPhase, false, "project search must never mutate GitHub");
    if (path.endsWith("/issues")) {
      assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM project_audit_runs").get()!.n, 1, "audit is enqueued before map delivery");
      return Response.json({ number: 1 });
    }
    return new Response(null, { status: 204 });
  }
  throw new Error("Unmocked network " + path);
};
const scalar = (sql: string) => Number(getDb().prepare(sql).get()!.n);
const nextAudit = () => store.listDueJobs(20).find(j => j.kind === "project_audit")!;
try {
  const project = store.upsertProject("sample", "project");
  store.enqueueOverviewJob(project, { reason: "initial" }, true);
  const mapJob = store.listDueJobs(1)[0];
  await runJob(mapJob);
  assert.equal(mapCalls, 1); assert.equal(scalar("SELECT COUNT(*) AS n FROM project_maps"), 1);
  assert.equal(scalar("SELECT COUNT(*) AS n FROM project_audit_runs"), 1);
  const map = auditStore.latestProjectMap(project)!;
  auditStore.enqueueProjectAudit(map, true); assert.equal(scalar("SELECT COUNT(*) AS n FROM project_audit_runs"), 1);
  auditPhase = true;
  const first = nextAudit(); await runJob(first);
  assert.equal(searchCalls, 1); assert.equal(verificationCalls, 1);
  assert.equal(scalar("SELECT COUNT(*) AS n FROM findings WHERE scope='project' AND status='open'"), 1);
  assert.equal(auditStore.latestProjectAudit(project)!.status, "done");
  const firstAnalysis = store.getAnalysis(auditStore.latestProjectAudit(project)!.analysisId!)!;
  assert.equal(firstAnalysis.outcome, "ok", "normal exclusions do not make a completed search partial");
  assert.equal(firstAnalysis.summary, "Поиск завершён: новых подтверждённых замечаний 1.");
  assert.ok(!firstAnalysis.comment!.includes("CSV values"));
  assert.ok(JSON.stringify(getDb().prepare("SELECT diagnostics_json FROM analyses WHERE id=?").get(firstAnalysis.id)).includes("CSV values"));
  const legacyId = store.recordAnalysis({ prId: first.prId, headSha: sha, trigger: "project_audit", outcome: "partial",
    summary: "Поиск с ограничениями: новых подтверждённых замечаний 1, непроверенных вопросов 6.",
    rawResponse: JSON.stringify({ result: { accepted: [{ title: "Confirmed legacy issue" }] } }) });
  store.setAnalysisComment(legacyId, "Непроверенный вопрос: legacy hypothesis");
  assert.equal(store.getAnalysis(legacyId)!.outcome, "ok");
  assert.ok(!store.getAnalysis(legacyId)!.comment!.includes("hypothesis"));
  assert.equal(store.listProjectAnalyses(project).find(a => a.id === legacyId)!.outcome, "ok");
  assert.equal(getDb().prepare("SELECT outcome FROM analyses WHERE id=?").get(legacyId)!.outcome, "partial", "legacy raw history stays immutable");
  assert.equal(store.getProjectNotes(project)!.body, notes);
  assert.equal(store.getMemorySha(project), sha);
  await executeProjectAuditJob(first); assert.equal(searchCalls, 1, "crash after commit must not rerun search");
  getDb().prepare("UPDATE review_jobs SET status='queued' WHERE id=?").run(first.id);
  process.env.TOKENS_PER_DAY = "1";
  await runJob(first);
  assert.equal(auditStore.latestProjectAudit(project)!.status, "done", "committed audit completes before daily budget admission");
  assert.equal(searchCalls, 1);
  process.env.TOKENS_PER_DAY = "8000000";
  const writesBefore = githubWrites;
  assert.equal(await startProjectAudit(project), "queued"); assert.equal(await startProjectAudit(project), "active");
  await runJob(nextAudit());
  assert.equal(scalar("SELECT COUNT(*) AS n FROM findings"), 1, "manual repeat must not duplicate an existing problem");
  assert.equal(githubWrites, writesBefore);
  const firstFinding = getDb().prepare("SELECT id FROM findings").get()!.id;
  getDb().prepare("UPDATE findings SET status='closed' WHERE id=?").run(firstFinding);
  historyVerdict = "regression";
  await startProjectAudit(project); await runJob(nextAudit());
  assert.equal(scalar("SELECT COUNT(*) AS n FROM findings"), 2);
  assert.equal(getDb().prepare("SELECT status FROM findings WHERE id=?").get(firstFinding)!.status, "closed");
  console.log("ok audit queue: initial map without PR -> one audit, project findings, manual repeat, regressions, unchanged map/statuses and zero GitHub writes");

  historyVerdict = "duplicate";
  unconfirmed = true;
  await startProjectAudit(project); await runJob(nextAudit());
  const unconfirmedAnalysis = store.getAnalysis(auditStore.latestProjectAudit(project)!.analysisId!)!;
  assert.equal(unconfirmedAnalysis.outcome, "ok");
  assert.equal(unconfirmedAnalysis.summary, "Поиск завершён: новых подтверждённых замечаний 0.");
  assert.ok(!unconfirmedAnalysis.comment!.includes("Insufficient evidence"));
  assert.equal(scalar("SELECT COUNT(*) AS n FROM findings"), 2);
  unconfirmed = false;
  await startProjectAudit(project);
  failVerification = true;
  const interrupted = nextAudit(); await runJob(interrupted);
  assert.equal(auditStore.latestProjectAudit(project)!.status, "queued");
  assert.equal(getDb().prepare("SELECT outcome FROM analyses WHERE json_extract(diagnostics_json,'$.jobId')=? ORDER BY id DESC LIMIT 1").get(interrupted.id)!.outcome, "error", "real transport failures remain incomplete");
  const searchesBefore = searchCalls;
  failVerification = false;
  getDb().prepare("UPDATE review_jobs SET run_after=datetime('now') WHERE id=?").run(interrupted.id);
  await runJob(nextAudit());
  assert.equal(searchCalls, searchesBefore, "resume only verifies saved candidates");
  assert.equal(scalar("SELECT COUNT(*) AS n FROM findings"), 2);
  assert.ok(pipelineDailyLiability(project) >= 0);

  await startProjectAudit(project); head = "b".repeat(40); await runJob(nextAudit());
  const stale = auditStore.latestProjectAudit(project)!;
  assert.equal(store.getAnalysis(stale.analysisId!)!.outcome, "stale");
  assert.equal(await startProjectAudit(project), "map_required");
  assert.equal(scalar("SELECT COUNT(*) AS n FROM findings"), 2);
  head = sha;
  process.env.PROJECT_AUDIT_ENABLED = "false";
  assert.equal(await startProjectAudit(project), "disabled");
  process.env.PROJECT_AUDIT_ENABLED = "true";
  store.setProjectStatus(project, "paused"); assert.equal(await startProjectAudit(project), "paused");
  store.setProjectStatus(project, "active");
  assert.equal(scalar("SELECT COUNT(*) AS n FROM pull_requests WHERE number!=0"), 0);
  store.deleteProjectCascade(project);
  assert.equal(scalar("SELECT COUNT(*) AS n FROM project_maps"), 0);
  assert.equal(scalar("SELECT COUNT(*) AS n FROM project_audit_runs"), 0);
  assert.equal(scalar("SELECT COUNT(*) AS n FROM context_pipeline_parts"), 0);
  assert.equal(getDb().prepare("PRAGMA user_version").get()!.user_version, 24);
  console.log("ok audit queue: retry without repeated search, stale SHA, disabled/paused guards, no artificial PR and cascade cleanup");

  auditPhase = false;
  raceProject = store.upsertProject("sample", "project");
  store.enqueueOverviewJob(raceProject, { reason: "initial" }, true);
  const atomicMap = store.listDueJobs(1)[0];
  getDb().exec("CREATE TEMP TRIGGER crash_audit BEFORE INSERT ON project_audit_runs BEGIN SELECT RAISE(ABORT,'simulated transaction crash'); END;");
  await runJob(atomicMap);
  assert.equal(scalar("SELECT COUNT(*) AS n FROM project_maps"), 0);
  assert.equal(scalar("SELECT COUNT(*) AS n FROM project_audit_runs"), 0);
  assert.equal(store.getProjectNotes(raceProject), null, "failed child enqueue rolls back the map transaction");
  const mapsBefore = mapCalls;
  getDb().exec("DROP TRIGGER crash_audit");
  getDb().prepare("UPDATE review_jobs SET run_after=datetime('now') WHERE id=?").run(atomicMap.id);
  await runJob(store.listDueJobs(1)[0]);
  assert.equal(mapCalls, mapsBefore, "retry uses the saved map answer");
  assert.equal(scalar("SELECT COUNT(*) AS n FROM project_audit_runs"), 1);
  raceOnVerify = true; auditPhase = true;
  const beforeRaceSearch = searchCalls, beforeRaceVerify = verificationCalls;
  await runJob(nextAudit());
  assert.equal(searchCalls, beforeRaceSearch + 1, "concurrent supervisor edit does not repeat search");
  assert.equal(verificationCalls, beforeRaceVerify + 2, "changed requirements are independently checked again");
  assert.equal(store.getProjectNotes(raceProject)!.body, "Changed supervisor requirement");
  assert.equal(scalar("SELECT COUNT(*) AS n FROM findings"), 1);
  await startProjectAudit(raceProject);
  const beforeLimit = searchCalls;
  process.env.TOKENS_PER_DAY = "1";
  await runJob(nextAudit());
  assert.equal(searchCalls, beforeLimit, "daily cap prevents paid work");
  assert.equal(auditStore.latestProjectAudit(raceProject)!.status, "queued");
  process.env.TOKENS_PER_DAY = "8000000";
  getDb().prepare("UPDATE review_jobs SET run_after=datetime('now') WHERE id=?").run(auditStore.latestProjectAudit(raceProject)!.jobId);
  const disabledJob = nextAudit();
  process.env.PROJECT_AUDIT_ENABLED = "false";
  await runJob(disabledJob);
  assert.equal(wakeChangedPipelineJobs(), 0, "unchanged disabled flag must not wake blocked audit");
  assert.equal(wakeChangedPipelineJobs(), 0);
  process.env.PROJECT_AUDIT_ENABLED = "true";
  assert.equal(wakeChangedPipelineJobs(), 1, "enabling audit wakes exactly the blocked job");
  store.deleteProjectCascade(raceProject);
  console.log("ok audit queue: atomic map/child crash recovery, concurrent human requirements recheck and daily-budget admission");
} finally { getDb().close(); await rm(directory, { recursive: true, force: true }); }
