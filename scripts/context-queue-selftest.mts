/** New PR adapter + real SQLite/outbox/worker. Every model/GitHub surface is mocked. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { diffSources, type DiffChange, type ReviewRepository } from "@/lib/curator/pr-full-diff";
import { ExecutionBudgetError } from "@/lib/llm/execution";
import type { ContextReviewDependencies } from "@/lib/curator/context-review";

const directory = await mkdtemp(join(tmpdir(), "context-queue-"));
Object.assign(process.env, { DATABASE_PATH: join(directory, "test.db"), REVIEW_MODE: "context", CURATOR_REVIEWER: "llm",
  LLM_PROVIDER: "selectel", LLM_MODEL: "fixture", SELECTEL_API_KEY: "fixture", GITHUB_APP_ID: "1", GITHUB_WEBHOOK_SECRET: "test",
  GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64") });
delete process.env.GITHUB_APP_PRIVATE_KEY_PATH; delete process.env.LLM_FALLBACK_PROVIDER;
const { getDb } = await import("@/lib/db");
const store = await import("@/lib/curator/store");
const { runContextReview } = await import("@/lib/curator/context-review");
const { runJob } = await import("@/lib/curator/worker");
const { executeCommitJob } = await import("@/lib/curator/review");
const { durablePipelineBudget, loadPipelineJob, patchPipelineJob, wakeChangedPipelineJobs, pipelineDailyLiability } = await import("@/lib/curator/pipeline-job");
const project = store.createProjectManual("org", "repo"), head = "b".repeat(40), base = "a".repeat(40);
const change: DiffChange = { oldMode: "100644", newMode: "100644", oldBlob: "c".repeat(40), newBlob: "d".repeat(40), oldPath: "code.ts", newPath: "code.ts", status: "M" };
const repository: ReviewRepository = { base, mergeBase: base, head, changes: [change],
  sources: diffSources(Buffer.from("diff --git a/code.ts b/code.ts\n--- a/code.ts\n+++ b/code.ts\n@@ -1 +1 @@\n-return 1;\n+return 2;\n"), [change], base + head), readFile: async () => null };
const comments = new Map<string, string>();
let modelCalls = 0, limited = false, refresh = false, failPost = false, liveBase = base, httpRejection = 0, candidate = false, liveMerged = false;
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
let activeJob = 0;
faux.setResponses(Array.from({ length: 30 }, () => () => {
  modelCalls++;
  assert.ok(loadPipelineJob(activeJob).budget?.calls.some(c => c.status === "started"), "request start is durable before provider execution");
  return fauxAssistantMessage(fauxText(JSON.stringify({ summary: "Reviewed", changes: "Changed return value", unresolved: limited ? ["cannot verify fixture"] : [], refresh_overview: refresh ? "Changed public contract" : null,
    findings: candidate ? [{ prior_id: null, status: "open", area: "code", severity: "important", title: "Fixture error", description: "wrong value", evidence: "return 2", impact: "wrong output", recommendation: "restore", verify: "return 1", root_cause: "changed value", source_ids: [repository.sources[0].id], locations: [{ kind: "file", target: "code.ts", detail: "1" }] }] : [] })));
}));
const targets = { primary: { provider: "fixture", model: faux.getModel(), stream: models.streamSimple.bind(models), contextTokens: 128000 }, fallback: undefined, maxTokens: 950000, timeoutMs: 60000 };
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith("/chat/completions") && httpRejection) return Response.json({ error: { code: httpRejection === 400 ? "context_length_exceeded" : "rate_limit", message: "fixture rejection" } }, { status: httpRejection });
  if (path.endsWith("/access_tokens")) return Response.json({ token: "fixture", expires_at: "2099-01-01T00:00:00Z" });
  if (/\/pulls\/\d+$/.test(path)) return Response.json({ head: { sha: head }, base: { sha: liveBase }, body: "fixture", changed_files: 1, merged: liveMerged, state: liveMerged ? "closed" : "open" });
  if (path.endsWith("/comments") && init?.method === "POST") {
    const body = JSON.parse(String(init.body)).body as string;
    comments.set(path, body);
    if (failPost) { failPost = false; throw new Error("lost POST response"); }
    return Response.json({ id: comments.size });
  }
  if (path.endsWith("/comments")) return Response.json(comments.has(path) ? [{ body: comments.get(path) }] : []);
  throw new Error("Unmocked external request " + path);
};
function job(number: number) {
  const prId = store.upsertPullRequest(project, number, { headSha: head, headRef: "work", baseRef: "main", state: "open" });
  const params = { owner: "org", repo: "repo", prNumber: number, headSha: head, installationId: 1, headRef: "work" };
  const { jobId } = store.enqueueCommitJob({ prId, headSha: head, payload: { ...params, reviewMode: "context" }, delayMs: 0, deadlineMs: 3600000 });
  assert.ok(jobId);
  return { params, prId, jobId };
}
function worker(fixture: ReturnType<typeof job>, maxTokens = 950000, selectedRepository = repository, ask?: ContextReviewDependencies["ask"]) {
  return { runCommit: async (queued: Parameters<typeof runJob>[0], options?: { cacheOnly: boolean }) => {
    activeJob = queued.id;
    if (!store.stagedJobPublication(queued.id)) await runContextReview(fixture.params, fixture.prId, queued.id, {
      isCurrent: () => store.getPullRequest(fixture.prId)?.headSha === head, validateCurrent: async () => true,
      fixesFinal: () => store.getPullRequest(fixture.prId)?.mergedIntoDefault ?? false,
      cacheOnly: options?.cacheOnly,
      stage: report => store.stageJobPublication(queued.id, report.analysisId, `review-${queued.id}`, report.comment),
    }, { targets: { ...targets, maxTokens }, withRepository: async (_params, consume) => consume(selectedRepository), ask });
    await executeCommitJob(fixture.params, fixture.prId, queued.id, 0, options?.cacheOnly);
  }, runComment: async () => {}, runOverview: async () => {}, concludeUnreviewed: async () => {}, concludePublished: async () => {}, reportFailure: async () => {} };
}
function queued(id: number) {
  getDb().prepare("UPDATE review_jobs SET status='queued', run_after=datetime('now') WHERE id=?").run(id);
  return store.listDueJobs(100).find(j => j.id === id)!;
}
try {
  // Unknown in-flight charges are restored once; active timeout resets independently of spend.
  const accounting = job(1);
  let account = durablePipelineBudget(accounting.jobId, 950000, 60000);
  account.budget.recordCall({ id: "interrupted", phase: "research", provider: "fixture", model: "fixture", startedAt: Date.now(), status: "started", inputTokens: 0, outputTokens: 0, usageSource: "unknown", reservedTokens: 900 });
  assert.equal(loadPipelineJob(accounting.jobId).budget?.calls[0].status, "started");
  account = durablePipelineBudget(accounting.jobId, 950000, 60000);
  assert.equal(account.budget.unknownTokens, 900);
  account = durablePipelineBudget(accounting.jobId, 950000, 60000);
  assert.equal(account.budget.unknownTokens, 900, "unknown request charged once across multiple restarts");
  store.finishJob(accounting.jobId, "done");

  // Persistent budget shortage waits for a changed configuration, without paid blind loops.
  const blocked = job(2), beforeBlocked = modelCalls;
  await runJob(queued(blocked.jobId), worker(blocked, 100));
  assert.equal(modelCalls, beforeBlocked);
  assert.equal(getDb().prepare("SELECT note FROM review_jobs WHERE id=?").get(blocked.jobId)?.note, "pipeline-blocked");
  assert.ok(!store.listDueJobs(100).some(j => j.id === blocked.jobId));
  assert.equal(wakeChangedPipelineJobs(), 0);
  process.env.PR_TOKENS_PER_RUN = "950000";
  assert.equal(wakeChangedPipelineJobs(), 1);
  await runJob(queued(blocked.jobId), worker(blocked));
  assert.equal(loadPipelineJob(blocked.jobId).quality, "complete");

  // Final reconciliation and exact publication are atomic; delivery retry never researches.
  const delivery = job(3); failPost = true;
  await runJob(queued(delivery.jobId), worker(delivery));
  const afterReview = modelCalls;
  assert.ok(store.stagedJobPublication(delivery.jobId));
  await runJob(queued(delivery.jobId), worker(delivery));
  assert.equal(modelCalls, afterReview);
  assert.equal(loadPipelineJob(delivery.jobId).delivery, "delivered");

  limited = true;
  const partial = job(4);
  await runJob(queued(partial.jobId), worker(partial));
  const afterPartial = modelCalls;
  assert.equal(loadPipelineJob(partial.jobId).quality, "limited");
  await runJob(queued(partial.jobId), { ...worker(partial), runCommit: async () => { throw new Error("terminal partial publication must not repeat model analysis"); } });
  assert.equal(modelCalls, afterPartial);
  limited = false;

  // Rollback after analysis INSERT but before diagnostics UPDATE loses no accounting linkage.
  const boundary = job(5); activeJob = boundary.jobId;
  store.markJobRunning(boundary.jobId);
  getDb().exec("CREATE TRIGGER crash_diagnostics BEFORE UPDATE OF diagnostics_json ON analyses BEGIN SELECT RAISE(ABORT,'crash after analysis insert'); END;");
  const execute = () => runContextReview(boundary.params, boundary.prId, boundary.jobId, {
    validateCurrent: async () => true, stage: report => store.stageJobPublication(boundary.jobId, report.analysisId, `review-${boundary.jobId}`, report.comment),
  }, { targets, withRepository: async (_params, consume) => consume(repository) });
  await assert.rejects(execute(), /crash after analysis insert/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM analyses WHERE pull_request_id=?").get(boundary.prId)?.n, 0);
  getDb().exec("DROP TRIGGER crash_diagnostics");
  const boundaryCalls = modelCalls;
  process.env.TOKENS_PER_DAY = "1";
  await runJob(queued(boundary.jobId), worker(boundary));
  delete process.env.TOKENS_PER_DAY;
  assert.equal(modelCalls, boundaryCalls, "completed result survives diagnostics transaction failure");
  const billed = getDb().prepare("SELECT SUM(tokens_in+tokens_out) AS tokens FROM analyses WHERE pull_request_id=?").get(boundary.prId)?.tokens;
  const spent = loadPipelineJob(boundary.jobId).budget!.spent;
  assert.equal(billed, spent.input + spent.output);
  store.finishJob(boundary.jobId, "done");

  // Base changes keep the same job/budget but never mix old source checkpoints.
  const moved = job(6); liveBase = "e".repeat(40);
  await runJob(queued(moved.jobId), worker(moved));
  assert.equal(store.stagedJobPublication(moved.jobId), null);
  assert.equal(loadPipelineJob(moved.jobId).reason, "base_changed");
  const oldSpend = loadPipelineJob(moved.jobId).budget!.spent.input;
  await runJob(queued(moved.jobId), worker(moved, 950000, { ...repository, base: liveBase }));
  assert.equal(loadPipelineJob(moved.jobId).quality, "complete");
  assert.ok(loadPipelineJob(moved.jobId).budget!.spent.input > oldSpend);

  liveBase = base; refresh = true; liveMerged = true;
  const merged = job(7);
  store.upsertPullRequest(project, 7, { headSha: head, state: "merged", mergedIntoDefault: true });
  await runJob(queued(merged.jobId), worker(merged));
  assert.ok(getDb().prepare("SELECT id FROM review_jobs WHERE kind='overview' AND status='queued'").get(), "late merged-PR review queues its requested project overview");
  refresh = false;
  const mergedOther = job(14);
  store.upsertPullRequest(project, 14, { headSha: head, state: "merged", mergedIntoDefault: false, baseRef: "integration" });
  const overviewsBeforeOther = getDb().prepare("SELECT COUNT(*) AS n FROM review_jobs WHERE kind='overview'").get()?.n;
  await runJob(queued(mergedOther.jobId), worker(mergedOther));
  assert.equal(loadPipelineJob(mergedOther.jobId).quality, "complete", "merged into another branch is a legitimate completed PR review");
  assert.equal(loadPipelineJob(mergedOther.jobId).delivery, "delivered");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM review_jobs WHERE kind='overview'").get()?.n, overviewsBeforeOther);
  liveMerged = false;
  assert.equal(pipelineDailyLiability(null), 900, "unknown charges remain in daily admission without changing billed usage");
  const pendingCall = job(8);
  store.markJobRunning(pendingCall.jobId);
  const pendingBudget = durablePipelineBudget(pendingCall.jobId, 950000, 60000);
  pendingBudget.budget.recordCall({ id: "in-flight", phase: "research", provider: "fixture", model: "fixture", startedAt: Date.now(), status: "started", inputTokens: 0, outputTokens: 0, usageSource: "unknown", reservedTokens: 50 });
  assert.equal(pipelineDailyLiability(null), 950, "in-flight liability is counted once without reserving an entire950k for a tiny PR");
  process.env.TOKENS_PER_DAY = "900";
  assert.throws(() => pendingBudget.budget.recordCall({ id: "daily-blocked", phase: "research", provider: "fixture", model: "fixture", startedAt: Date.now(), status: "started", inputTokens: 0, outputTokens: 0, usageSource: "unknown", reservedTokens: 100 }), { reason: "daily_tokens" });
  assert.equal(loadPipelineJob(pendingCall.jobId).budget?.calls.length, 1, "refused daily request is never marked as externally submitted");
  delete process.env.TOKENS_PER_DAY;
  store.finishJob(pendingCall.jobId, "done");
  for (const status of [400, 429]) {
    const rejected = job(10 + status), rejectionBudget = durablePipelineBudget(rejected.jobId, 950000, 60000);
    httpRejection = status;
    const { chat } = await import("@/lib/llm/chat");
    await assert.rejects(chat([{ role: "user", content: "fixture" }], { budget: rejectionBudget.budget, maxOutputTokens: 1000, contextTokens: 128000 }));
    assert.equal(rejectionBudget.budget.unknownTokens, 0);
    assert.equal(pipelineDailyLiability(null), 950, "known HTTP rejection is not uncertain paid liability");
    store.finishJob(rejected.jobId, "done");
  }
  httpRejection = 0; candidate = true;
  const deferred = job(9);
  getDb().prepare("UPDATE review_jobs SET created_at=datetime('now','-2 days') WHERE id=?").run(deferred.jobId);
  await runJob(queued(deferred.jobId), worker(deferred, 950000, repository, async () => { throw new ExecutionBudgetError("daily_tokens"); }));
  assert.equal(store.stagedJobPublication(deferred.jobId), null, "temporary verifier daily shortage is not a terminal partial publication");
  assert.equal(loadPipelineJob(deferred.jobId).recovery, "retryable");
  assert.equal(getDb().prepare("SELECT status FROM review_jobs WHERE id=?").get(deferred.jobId)?.status, "queued", "daily wait survives technical retry window");
  const beforeVerificationRetry = modelCalls;
  await runJob(queued(deferred.jobId), worker(deferred, 950000, repository, async messages => {
    const data = JSON.parse(messages[1].content.split("\nИсходные материалы:\n")[0]) as { candidates: Array<{ id: string }> };
    return { provider: "fixture", model: "fixture", usage: { input: 0, output: 0 }, content: JSON.stringify({ verdicts: data.candidates.map(c => ({ id: c.id, status: "confirmed", reason: "confirmed source" })) }) };
  }));
  assert.equal(modelCalls, beforeVerificationRetry, "next-day recovery repeats only unfinished verification");
  assert.equal(loadPipelineJob(deferred.jobId).quality, "complete");
  candidate = false;

  const overview = store.listDueJobs(100).find(j => j.kind === "overview")!;
  assert.ok(overview);
  process.env.OVERVIEW_TOKENS_PER_RUN = "bad";
  const beforeInvalidSetting = modelCalls;
  await runJob(overview, { ...worker(merged), runOverview: async () => { throw new Error("invalid overview budget must not execute the model"); } });
  assert.equal(getDb().prepare("SELECT note FROM review_jobs WHERE id=?").get(overview.id)?.note, "pipeline-blocked");
  assert.equal(modelCalls, beforeInvalidSetting);
  delete process.env.OVERVIEW_TOKENS_PER_RUN;
  assert.equal(wakeChangedPipelineJobs(), 1, "fixed overview budget wakes the blocked job");
  assert.ok(store.listDueJobs(100).some(j => j.id === overview.id));
  store.finishJob(overview.id, "done");

  const beforeDelete = getDb().prepare("SELECT COUNT(*) AS n FROM context_pipeline_parts WHERE job_id=?").get(boundary.jobId)?.n as number;
  assert.ok(beforeDelete > 0);
  getDb().prepare("DELETE FROM review_jobs WHERE id=?").run(boundary.jobId);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM context_pipeline_parts WHERE job_id=?").get(boundary.jobId)?.n, 0);
  patchPipelineJob(moved.jobId, { delivery: "delivered" });
  console.log("ok context queue: durable starts/spend, unknown once, blocked wake, atomic reconciliation/accounting, delivery-only retries, terminal partial, base revision replan and cache cleanup");
} finally { getDb().close(); await rm(directory, { recursive: true, force: true }); }
