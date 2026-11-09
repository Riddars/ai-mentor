/** Offline acceptance test. Real webhook, queue, SQLite, review parser and panel queries. */
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";


const dir = mkdtempSync(join(tmpdir(), "private-pr-test-"));
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" });
Object.assign(process.env, { DATABASE_PATH: join(dir, "db"), GITHUB_APP_ID: "1", GITHUB_WEBHOOK_SECRET: "test",
  GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(key).toString("base64"), CURATOR_REVIEWER: "llm",
  REVIEW_MODE: "diff", LLM_PROVIDER: "openai", OPENAI_API_KEY: "test", LLM_MODEL: "fixture" });
delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
delete process.env.LLM_FALLBACK_PROVIDER;
const { POST } = await import("@/app/api/github/webhook/route");
const store = await import("@/lib/curator/store");
const { getDb } = await import("@/lib/db");
const { recoverMergedPullRequests, runJob } = await import("@/lib/curator/worker");
const { executeCommentJob, startCommitReview } = await import("@/lib/curator/review");
const { checkRepositorySetup } = await import("@/lib/github/setup");

const repo = { name: "private", private: true, default_branch: "main", owner: { login: "org" } };
const project = { owner: "org", repo: "private", id: store.createProjectManual("org", "private") };
const comments: string[] = [];
const livePulls = new Map<number, ReturnType<typeof pull>>();
let brokenModel = false;
let dropCommentResponse = false;
let modelCalls = 0;
let checkId = 0;
let customAnswer: unknown = null;
let duringModel: (() => void) | null = null;
let failAnswerPost = false;
let rejectReviewPost = false;
let failPrGet = 0;
let failCheckPatch = false;
let pauseGet: { number: number; arrived: () => void; wait: Promise<void> } | null = null;
const mergeShas = new Map<number, string>();
let mergeBlob = "same-blob";
let mainBlob = "same-blob";
function pull(number: number, merged = true) {
  return { number, state: "closed", merged, author_association: "MEMBER", changed_files: 1, body: "",
    user: { login: "student" }, head: { sha: "final", ref: "work" }, merge_commit_sha: mergeShas.get(number), base: { ref: "main", repo } };
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "api.openai.com" && url.pathname.endsWith("/chat/completions")) {
    modelCalls++;
    duringModel?.(); duringModel = null;
    const content = customAnswer ? JSON.stringify(customAnswer) : brokenModel ? "invalid" : JSON.stringify({ summary: "Fixture review", findings: [
      { title: "Training on test data", status: "open", file: "train.py", lines: "1" }] });
    return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
  }
  assert.equal(url.hostname, "api.github.com");
  const path = url.pathname;
  if (path.endsWith("/hidden/installation")) return new Response(null, { status: 404 });
  if (path.endsWith("/public")) return Response.json({ ...repo, private: false });
  if (path.endsWith("/no-rules")) return Response.json({ ...repo, private: false });
  if (path.endsWith("/rules/branches/main") && path.includes("/no-rules/")) return new Response(null, { status: 404 });
  if (path.endsWith("/rules/branches/main") && path.includes("/public/")) return Response.json([{ type: "pull_request" },
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "AI Curator", integration_id: 1 }] } }]);
  if (path.endsWith("/branches/main")) return Response.json({ commit: { sha: "observed-main" } });
  if (path.endsWith("/installation")) return Response.json({ id: 1 });
  if (path.endsWith("/access_tokens")) return Response.json({ token: "test", expires_at: "2099-01-01" });
  if (path.endsWith("/org/private")) return Response.json(repo);
  if (path.endsWith("/collaborators")) return Response.json([{ login: "student" }]);
  if (path.endsWith("/pulls")) {
    const now = new Date().toISOString();
    return Response.json([{ number: 4, updated_at: now, merged_at: now },
      { number: 99, updated_at: now, merged_at: "2000-01-01T00:00:00Z" }]);
  }
  if (path.endsWith("/files")) return Response.json([{ filename: "train.py", status: "added",
    additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+fit(test)" }]);
  if (path.includes("/contents/train.py")) return Response.json({ type: "file", sha:
    url.searchParams.get("ref") === "observed-main" ? mainBlob :
    url.searchParams.get("ref")?.startsWith("merge-") ? mergeBlob : "same-blob" });
  if (path.includes("/contents/")) return new Response(null, { status: 404 });
  if (path.endsWith("/comments") && init?.method === "POST") {
    const body = JSON.parse(String(init.body)).body as string;
    if (failAnswerPost && body.includes("ai-curator-once:answer-")) {
      failAnswerPost = false;
      throw new Error("POST rejected before GitHub saved comment");
    }
    if (rejectReviewPost && body.includes("ai-curator-once:review-")) {
      rejectReviewPost = false;
      throw new Error("Review POST rejected");
    }
    comments.push(path + " " + body);
    if (dropCommentResponse && body.includes("ai-curator-once:review-")) {
      dropCommentResponse = false;
      throw new Error("GitHub saved the comment but the response was lost");
    }
    return Response.json({});
  }
  if (path.endsWith("/comments")) {
    return Response.json(comments.filter((comment) => comment.startsWith(`${path} `))
      .map((comment) => ({ body: comment.slice(comment.indexOf(" ") + 1), user: { type: "Bot" }, performed_via_github_app: { id: 1 } })));
  }
  if (path.includes("/check-runs")) {
    if (failCheckPatch && init?.method === "PATCH") throw new Error("Check PATCH failed");
    return Response.json({ id: ++checkId });
  }
  const match = path.match(/\/pulls\/(\d+)$/);
  if (match) {
    const number = Number(match[1]);
    if (failPrGet === number) { failPrGet = 0; throw new Error("Validation GET failed"); }
    const snapshot = livePulls.get(number) ?? pull(number);
    if (pauseGet?.number === number) {
      const pause = pauseGet; pauseGet = null; pause.arrived(); await pause.wait;
    }
    return Response.json(snapshot);
  }
  throw new Error("Unexpected request " + path);
};
async function webhook(action: string, pr: ReturnType<typeof pull>, targetRepo = repo) {
  if (action === "closed" || !livePulls.has(pr.number) || livePulls.get(pr.number)?.state !== "closed") {
    livePulls.set(pr.number, pr);
  }
  const body = JSON.stringify({ action, repository: targetRepo, installation: { id: 1 }, pull_request: pr });
  const signature = createHmac("sha256", "test").update(body).digest("hex");
  const result = await POST(new Request("http://localhost/api/github/webhook", { method: "POST", body,
    headers: { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=" + signature } }));
  assert.equal(result.status, 200);
}
async function studentComment(prNumber: number, commentId: number) {
  const body = JSON.stringify({ action: "created", repository: repo, installation: { id: 1 },
    issue: { number: prNumber, pull_request: {} },
    comment: { id: commentId, body: "Я исправил замечание", user: { login: "student" }, author_association: "MEMBER" },
    sender: { type: "User" } });
  const signature = createHmac("sha256", "test").update(body).digest("hex");
  const result = await POST(new Request("http://localhost/api/github/webhook", { method: "POST", body,
    headers: { "x-github-event": "issue_comment", "x-hub-signature-256": "sha256=" + signature } }));
  assert.equal(result.status, 200);
}
const db = getDb();
async function runNext() {
  const [job] = store.listDueJobs(1);
  assert.ok(job);
  await runJob(job);
  return job;
}
try {
  const setup = await checkRepositorySetup("org", "private", "1");
  assert.equal(setup.installed && setup.isPublic === false, true);
  assert.equal((await checkRepositorySetup("org", "hidden", "1")).installed, false);
  assert.equal((await checkRepositorySetup("org", "public", "1")).checkRequired, true);
  assert.equal((await checkRepositorySetup("org", "no-rules", "1")).checkRequired, false);
  await webhook("closed", pull(1));
  await webhook("closed", pull(1));
  await webhook("opened", { ...pull(1, false), state: "open", head: { sha: "older", ref: "work" } });
  const late = await runNext();
  assert.equal(late.headSha, "final");
  assert.equal(store.getPullRequest(late.prId)?.state, "merged");
  await webhook("closed", pull(1));
  assert.equal(comments.filter((comment) => comment.includes("Training on test data")).length, 1);
  assert.deepEqual({ ...db.prepare("SELECT scope, status FROM findings").get() }, { scope: "project", status: "open" });
  assert.equal(store.listDueJobs(10).length, 0);

  await webhook("opened", { ...pull(2, false), state: "open" });
  await webhook("closed", pull(2, false));
  assert.equal(store.listDueJobs(10).length, 0);
  await webhook("opened", { ...pull(3, false), state: "open" });
  assert.equal(comments.filter((comment) => comment.includes("ai-curator-once:pr-3")).length, 1);
  await webhook("opened", { ...pull(3, false), state: "open" });
  assert.equal(comments.filter((comment) => comment.includes("ai-curator-once:pr-3")).length, 1);
  await webhook("synchronize", { ...pull(3, false), state: "open", head: { sha: "second", ref: "work" } });
  await webhook("closed", { ...pull(3), head: { sha: "second", ref: "work" } });
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE status = 'queued'").run();
  assert.equal((await runNext()).headSha, "second");
  assert.equal(comments.filter((comment) => comment.includes("Training on test data")).length, 2);

  await recoverMergedPullRequests(project, 1, "test");
  brokenModel = true;
  const failed = await runNext();
  assert.equal(store.listUnreviewedPrs(project.id)[0]?.prId, failed.prId);
  brokenModel = false;
  assert.equal(await startCommitReview({ ...project, installationId: 1, prNumber: 4, headSha: "final" }, "restart"), "queued");
  await runNext();
  assert.equal(store.listUnreviewedPrs(project.id).length, 0);
  assert.equal(db.prepare("SELECT id FROM pull_requests WHERE number = 99").get(), undefined);
  // A review can finish while the PR is open. Its finding follows it into main.
  await webhook("opened", { ...pull(5, false), state: "open" });
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE status = 'queued'").run();
  const early = await runNext();
  await studentComment(5, 501);
  await studentComment(5, 501);
  assert.equal(comments.filter((comment) => comment.includes("ai-curator-once:reply-501")).length, 1);
  const beforeMerge = comments.length;
  await webhook("closed", pull(5));
  assert.equal(comments.length, beforeMerge);
  await runNext();
  assert.equal(comments.filter((comment) => comment.includes("ai-curator-once:answer-501")).length, 1);
  const replyJob = db.prepare("SELECT id FROM review_jobs WHERE kind = 'comment' ORDER BY id DESC LIMIT 1").get() as { id: number };
  await executeCommentJob({ owner: "org", repo: "private", prNumber: 5, installationId: 1, commentId: 501 }, replyJob.id);
  assert.equal(comments.filter((comment) => comment.includes("ai-curator-once:answer-501")).length, 1);
  const publicRepo = { ...repo, name: "public", private: false };
  const publicProject = store.createProjectManual("org", "public");
  const publicPr = { ...pull(10, false), state: "open", base: { ref: "main", repo: publicRepo } };
  await webhook("opened", publicPr, publicRepo);
  assert.equal(comments.filter((comment) => comment.includes("/public/issues/10/comments") && comment.includes("ai-curator-once:pr-10")).length, 1);
  await webhook("closed", { ...publicPr, state: "closed", merged: true }, publicRepo);
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE status = 'queued'").run();
  await runNext();
  assert.equal(comments.filter((comment) => comment.includes("/public/issues/10/comments") && comment.includes("Training on test data")).length, 1);
  assert.equal(store.getProject(publicProject)?.repo, "public");
  const lostResponsePr = { ...pull(11, false), state: "open" };
  await webhook("opened", lostResponsePr);
  await webhook("closed", { ...lostResponsePr, state: "closed", merged: true });
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE status = 'queued'").run();
  dropCommentResponse = true;
  await runNext();
  const callsBeforeRetry = modelCalls;
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE status = 'queued'").run();
  await runNext();
  assert.equal(modelCalls, callsBeforeRetry);
  assert.equal(comments.filter((comment) => comment.includes("/private/issues/11/comments") && comment.includes("ai-curator-once:review-")).length, 1);
  assert.equal(store.getPullRequest(early.prId)?.mergedIntoDefault, true);
  assert.equal(db.prepare("SELECT scope FROM findings WHERE pull_request_id = ?").get(early.prId)?.scope, "project");


  // Regression scenarios for publication and head validation.
  await webhook("opened", { ...pull(20, false), state: "open" });
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE status = 'queued'").run();
  const baseJob = await runNext();
  const finding = db.prepare("SELECT id FROM findings WHERE pull_request_id = ? ORDER BY id DESC LIMIT 1").get(baseJob.prId) as { id: number };

  await studentComment(20, 2001);
  brokenModel = true;
  await runNext();
  brokenModel = false;
  const invalidReply = comments.find((c) => c.includes("ai-curator-once:answer-2001"));
  assert.ok(invalidReply?.includes("Не удалось проверить комментарий"));
  assert.ok(!invalidReply?.includes("Комментарий проверен"));
  console.log("ok invalid model responses are reported as failure");

  await studentComment(20, 2002);
  customAnswer = { summary: "Explanation accepted", findings: [{ prior_id: finding.id,
    title: "Training on test data", status: "dismissed", reason: "Explanation proves no issue" }] };
  failAnswerPost = true;
  await runNext();
  assert.equal(db.prepare("SELECT status FROM findings WHERE id = ?").get(finding.id)?.status, "dismissed");
  assert.equal(comments.some((c) => c.includes("ai-curator-once:answer-2002")), false);
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE status = 'queued'").run();
  customAnswer = null;
  const callsBeforePublication = modelCalls;
  process.env.REVIEW_DAILY_LIMIT = "0"; // Publication must bypass model budgets.
  await runNext();
  delete process.env.REVIEW_DAILY_LIMIT;
  assert.equal(modelCalls, callsBeforePublication);
  const retriedReply = comments.find((c) => c.includes("ai-curator-once:answer-2002"));
  assert.ok(retriedReply?.includes("снято"));
  console.log("ok rejected POST resumes the exact saved answer without another model call");

  db.prepare("UPDATE findings SET status = 'open' WHERE id = ?").run(finding.id);
  await studentComment(20, 2003);
  customAnswer = { summary: "Stale answer", findings: [{ prior_id: finding.id,
    title: "Training on test data", status: "dismissed", reason: "Old-head explanation" }] };
  duringModel = () => { store.upsertPullRequest(project.id, 20, { state: "open", headSha: "new-head" }); };
  await runNext();
  customAnswer = null;
  assert.equal(store.getPullRequest(baseJob.prId)?.headSha, "new-head");
  assert.equal(db.prepare("SELECT status FROM findings WHERE id = ?").get(finding.id)?.status, "open");
  const oldAnalysis = db.prepare("SELECT head_sha FROM analyses WHERE pull_request_id = ? AND trigger = 'comment' ORDER BY id DESC LIMIT 1").get(baseJob.prId);
  assert.equal(oldAnalysis?.head_sha, "final");
  assert.equal(db.prepare("SELECT outcome FROM analyses WHERE pull_request_id = ? ORDER BY id DESC LIMIT 1").get(baseJob.prId)?.outcome, "stale");
  assert.equal(comments.some((c) => c.includes("ai-curator-once:answer-2003")), false);
  livePulls.set(20, { ...pull(20, false), state: "open", head: { sha: "new-head", ref: "work" } });
  await runNext();
  customAnswer = null;
  console.log("ok stale reply leaves finding open and retries on current head");

  const newer = { ...pull(21, false), state: "open", head: { sha: "newest-head", ref: "work" } };
  await webhook("opened", newer);
  const latePayload = JSON.stringify({ action: "synchronize", repository: repo, installation: { id: 1 },
    pull_request: { ...newer, head: { sha: "outdated-head", ref: "work" } } });
  const lateSig = createHmac("sha256", "test").update(latePayload).digest("hex");
  const lateResponse = await POST(new Request("http://localhost/api/github/webhook", { method: "POST", body: latePayload,
    headers: { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=" + lateSig } }));
  assert.equal(lateResponse.status, 200);
  const pr21 = db.prepare("SELECT head_sha FROM pull_requests WHERE number = 21").get();
  assert.equal(pr21?.head_sha, "newest-head");
  assert.equal(livePulls.get(21)?.head.sha, "newest-head");
  console.log("ok late synchronize keeps the live head");

  const projectFinding = db.prepare("SELECT id FROM findings WHERE scope = 'project' AND status = 'open' LIMIT 1").get() as { id: number };
  customAnswer = { summary: "Fixed in old head", findings: [{ prior_id: projectFinding.id,
    title: "Training on test data", status: "closed", reason: "Fixed in train.py" }] };
  await webhook("opened", { ...pull(22, false), state: "open" });
  // Run only PR22 so PR21's pending test job cannot affect this fixture.
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE pull_request_id = (SELECT id FROM pull_requests WHERE number = 22)").run();
  const job22 = store.listDueJobs(100).find((j) => j.payload && (j.payload as { prNumber?: number }).prNumber === 22);
  assert.ok(job22);
  await runJob(job22);
  customAnswer = null;
  assert.equal(db.prepare("SELECT status FROM findings WHERE id = ?").get(projectFinding.id)?.status, "pending");
  await webhook("synchronize", { ...pull(22, false), state: "open", head: { sha: "unchecked-head", ref: "work" } });
  await webhook("closed", { ...pull(22), head: { sha: "unchecked-head", ref: "work" } });
  assert.equal(db.prepare("SELECT status FROM findings WHERE id = ?").get(projectFinding.id)?.status, "open");
  const fixAnalysis = db.prepare("SELECT a.head_sha FROM findings f JOIN analyses a ON a.id = f.last_analysis_id WHERE f.id = ?").get(projectFinding.id);
  assert.equal(fixAnalysis?.head_sha, "final");
  console.log("ok merge does not close a pending fix validated on an older head");

  // Independent remaining scenarios start with no unfinished fixture jobs.
  db.prepare("UPDATE review_jobs SET status = 'superseded' WHERE status IN ('queued', 'running')").run();
  await webhook("opened", { ...pull(24, false), state: "open" });
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE status = 'queued'").run();
  rejectReviewPost = true;
  const stagedCommit = await runNext();
  const callsAtStage = modelCalls;
  await webhook("synchronize", { ...pull(24, false), state: "open", head: { sha: "next-head", ref: "work" } });
  await webhook("closed", { ...pull(24, false), head: { sha: "next-head", ref: "work" } });
  assert.equal(db.prepare("SELECT status FROM review_jobs WHERE id = ?").get(stagedCommit.id)?.status, "queued");
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE id = ?").run(stagedCommit.id);
  await runNext();
  assert.equal(modelCalls, callsAtStage);
  assert.equal(comments.filter((c) => c.includes(`ai-curator-once:review-${stagedCommit.id}`)).length, 1);
  console.log("ok staged publication survives new commits and closure without merge");

  await webhook("opened", { ...pull(31, false), state: "open" });
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE status = 'queued'").run();
  duringModel = () => { failPrGet = 31; };
  const validationJob = await runNext();
  const failedAnalysis = db.prepare("SELECT outcome, tokens_in, tokens_out FROM analyses WHERE pull_request_id = ? ORDER BY id DESC LIMIT 1").get(validationJob.prId);
  assert.equal(failedAnalysis?.outcome, "error");
  assert.equal(Number(failedAnalysis?.tokens_in) + Number(failedAnalysis?.tokens_out), 10);
  db.prepare("UPDATE review_jobs SET status = 'superseded' WHERE status = 'queued'").run();
  console.log("ok failed final validation records model spend");

  await webhook("opened", { ...pull(32, false), state: "open", head: { sha: "head-a", ref: "work" } });
  let releaseGet!: () => void;
  let getArrived!: () => void;
  const arrived = new Promise<void>((resolve) => { getArrived = resolve; });
  pauseGet = { number: 32, arrived: getArrived, wait: new Promise<void>((resolve) => { releaseGet = resolve; }) };
  const oldEvent = webhook("synchronize", { ...pull(32, false), state: "open", head: { sha: "head-a", ref: "work" } });
  await arrived;
  const newEvent = webhook("synchronize", { ...pull(32, false), state: "open", head: { sha: "head-b", ref: "work" } });
  releaseGet();
  await Promise.all([oldEvent, newEvent]);
  assert.equal(db.prepare("SELECT head_sha FROM pull_requests WHERE number = 32").get()?.head_sha, "head-b");
  db.prepare("UPDATE review_jobs SET status = 'superseded' WHERE status = 'queued'").run();
  console.log("ok concurrent webhooks cannot roll back the latest head");

  // A pre-merge fix closes only when its file blob also exists in the merge result.
  for (const [number, mode] of [[33, "same"], [34, "merge-changed"], [38, "main-changed"]] as const) {
    db.prepare("UPDATE findings SET status = 'open', resolved_by_pr_id = NULL WHERE id = ?").run(projectFinding.id);
    customAnswer = { findings: [{ prior_id: projectFinding.id, title: "Training on test data", status: "closed" }] };
    await webhook("opened", { ...pull(number, false), state: "open" });
    db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE status = 'queued'").run();
    await runNext();
    mergeShas.set(number, `merge-${number}`);
    mergeBlob = mode === "merge-changed" ? "different-blob" : "same-blob";
    mainBlob = mode === "main-changed" ? "different-blob" : "same-blob";
    customAnswer = null;
    await webhook("closed", pull(number));
    assert.equal(db.prepare("SELECT status FROM findings WHERE id = ?").get(projectFinding.id)?.status, mode === "same" ? "closed" : "open");
    db.prepare("UPDATE review_jobs SET status = 'superseded' WHERE status = 'queued'").run();
  }
  console.log("ok merged fixes require matching evidence in merge result and current main");

  await webhook("opened", { ...pull(35, false), state: "open" });
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE status = 'queued'").run();
  process.env.REVIEW_RETRY_WINDOW_MS = "0";
  failCheckPatch = true;
  duringModel = () => { throw new Error("Model unavailable at final attempt"); };
  const finalFailure = await runNext();
  delete process.env.REVIEW_RETRY_WINDOW_MS;
  assert.equal(db.prepare("SELECT note FROM review_jobs WHERE id = ?").get(finalFailure.id)?.note, "check-retry");
  const callsAtFailure = modelCalls;
  await webhook("synchronize", { ...pull(35, false), state: "open", head: { sha: "after-failure", ref: "work" } });
  assert.equal(db.prepare("SELECT status FROM review_jobs WHERE id = ?").get(finalFailure.id)?.status, "queued");
  failCheckPatch = false;
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE id = ?").run(finalFailure.id);
  await runNext();
  assert.equal(modelCalls, callsAtFailure);
  assert.equal(db.prepare("SELECT status FROM review_jobs WHERE id = ?").get(finalFailure.id)?.status, "failed");
  console.log("ok final failed check PATCH survives new commits and retries without invoking the model");
  db.prepare("UPDATE review_jobs SET status = 'superseded' WHERE status = 'queued'").run();

  // Simulate a deployed v17 job interrupted after GitHub accepted the review.
  await webhook("opened", { ...pull(36, false), state: "open" });
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE status = 'queued'").run();
  const legacyJob = store.listDueJobs(1)[0];
  assert.ok(legacyJob);
  store.recordAnalysis({ prId: legacyJob.prId, headSha: "final", trigger: "commit", outcome: "ok" });
  comments.push(`/repos/org/private/issues/36/comments old saved answer\n<!-- ai-curator-once:review-${legacyJob.id} -->`);
  const callsBeforeLegacy = modelCalls;
  await runNext();
  assert.equal(modelCalls, callsBeforeLegacy);
  assert.equal(db.prepare("SELECT comment FROM analyses WHERE pull_request_id = ? ORDER BY id DESC LIMIT 1").get(legacyJob.prId)?.comment?.toString().includes("old saved answer"), true);
  console.log("ok v17 lost-response recovery preserves the published answer");

  // The unpublished local v18 used an unprefixed publication marker.
  await webhook("opened", { ...pull(37, false), state: "open" });
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE status = 'queued'").run();
  const localLegacy = store.listDueJobs(1)[0];
  const localAnalysis = store.recordAnalysis({ prId: localLegacy.prId, headSha: "final", trigger: "commit", outcome: "ok" });
  const localKey = `ai-curator-review-${localLegacy.id}-${localAnalysis}`;
  store.stageJobPublication(localLegacy.id, localAnalysis, localKey, "local legacy answer");
  comments.push(`/repos/org/private/issues/37/comments local legacy answer\n<!-- ${localKey} -->`);
  const postsBeforeLegacy = comments.length;
  await runNext();
  assert.equal(comments.length, postsBeforeLegacy);
  assert.equal(modelCalls, callsBeforeLegacy);
  console.log("ok v18 legacy marker is recognized without duplicate publication");

} finally {
  globalThis.fetch = realFetch;
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 4 });
}
