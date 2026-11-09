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
function pull(number: number, merged = true) {
  return { number, state: "closed", merged, author_association: "MEMBER", changed_files: 1, body: "",
    user: { login: "student" }, head: { sha: "final", ref: "work" }, base: { ref: "main", repo } };
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "api.openai.com" && url.pathname.endsWith("/chat/completions")) {
    modelCalls++;
    const content = brokenModel ? "invalid" : JSON.stringify({ summary: "Fixture review", findings: [
      { title: "Training on test data", status: "open", file: "train.py", lines: "1" }] });
    return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
  }
  assert.equal(url.hostname, "api.github.com");
  const path = url.pathname;
  if (path.endsWith("/hidden/installation")) return new Response(null, { status: 404 });
  if (path.endsWith("/public")) return Response.json({ ...repo, private: false });
  if (path.endsWith("/no-rules")) return Response.json({ ...repo, private: false });
  if (path.endsWith("/rules/branches/main") && path.includes("/no-rules/")) return new Response(null, { status: 404 });
  if (path.endsWith("/rules/branches/main") && path.includes("/public/")) return Response.json([{ type: "pull_request" },
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "AI Curator", integration_id: 1 }] } }]);
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
  if (path.includes("/contents/")) return new Response(null, { status: 404 });
  if (path.endsWith("/comments") && init?.method === "POST") {
    const body = JSON.parse(String(init.body)).body as string;
    comments.push(path + " " + body);
    if (dropCommentResponse && body.includes("ai-curator-once:review-")) {
      dropCommentResponse = false;
      throw new Error("GitHub saved the comment but the response was lost");
    }
    return Response.json({});
  }
  if (path.endsWith("/comments")) {
    return Response.json(comments.filter((comment) => comment.startsWith(`${path} `))
      .map((comment) => ({ body: comment.slice(comment.indexOf(" ") + 1), user: { type: "Bot" } })));
  }
  if (path.includes("/check-runs")) return Response.json({ id: ++checkId });
  const match = path.match(/\/pulls\/(\d+)$/);
  if (match) return Response.json(livePulls.get(Number(match[1])) ?? pull(Number(match[1])));
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
  await executeCommentJob({ owner: "org", repo: "private", prNumber: 5, installationId: 1, commentId: 501 });
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

  assert.equal(store.enqueueOverviewJob(project.id, { reason: "manual" }, true), "queued");
  const [overview] = store.listDueJobs(1);
  assert.ok(store.markJobRunning(overview.id));
  assert.equal(store.enqueueOverviewJob(project.id, { reason: "merge" }, true, true), "queued");
  assert.equal(store.enqueueOverviewJob(project.id, { reason: "merge" }, true, true), "active");
  console.log("Public/private reviews, acknowledgements, merged replies and recovery passed.");
} finally {
  globalThis.fetch = realFetch;
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 4 });
}
