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
const { recoverPrivateMerges, runJob } = await import("@/lib/curator/worker");
const { startCommitReview } = await import("@/lib/curator/review");
const { checkRepositorySetup } = await import("@/lib/github/setup");

const repo = { name: "private", private: true, default_branch: "main", owner: { login: "org" } };
const project = { owner: "org", repo: "private", id: store.createProjectManual("org", "private") };
const comments: string[] = [];
let brokenModel = false;
let checkId = 0;
function pull(number: number, merged = true) {
  return { number, state: "closed", merged, author_association: "MEMBER", changed_files: 1, body: "",
    user: { login: "student" }, head: { sha: "final", ref: "work" }, base: { ref: "main", repo } };
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "api.openai.com" && url.pathname.endsWith("/chat/completions")) {
    const content = brokenModel ? "invalid" : JSON.stringify({ summary: "Fixture review", findings: [
      { title: "Training on test data", status: "open", file: "train.py", lines: "1" }] });
    return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
  }
  assert.equal(url.hostname, "api.github.com");
  const path = url.pathname;
  if (path.endsWith("/hidden/installation")) return new Response(null, { status: 404 });
  if (path.endsWith("/public")) return Response.json({ ...repo, private: false });
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
  if (path.endsWith("/comments")) {
    comments.push(path + " " + JSON.parse(String(init?.body)).body);
    return Response.json({});
  }
  if (path.includes("/check-runs")) return Response.json({ id: ++checkId });
  const match = path.match(/\/pulls\/(\d+)$/);
  if (match) return Response.json(pull(Number(match[1])));
  throw new Error("Unexpected request " + path);
};
async function webhook(action: string, pr: ReturnType<typeof pull>) {
  const body = JSON.stringify({ action, repository: repo, installation: { id: 1 }, pull_request: pr });
  const signature = createHmac("sha256", "test").update(body).digest("hex");
  const result = await POST(new Request("http://localhost/api/github/webhook", { method: "POST", body,
    headers: { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=" + signature } }));
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
  await webhook("closed", pull(1));
  await webhook("closed", pull(1));
  await webhook("opened", { ...pull(1, false), state: "open", head: { sha: "older", ref: "work" } });
  const late = await runNext();
  assert.equal(late.headSha, "final");
  assert.equal(store.getPullRequest(late.prId)?.state, "merged");
  await webhook("closed", pull(1));
  assert.equal(comments.length, 1);
  assert.match(comments[0], /issues\/1\/comments[\s\S]*AI Curator/);
  assert.match(comments[0], /Training on test data/);
  assert.deepEqual({ ...db.prepare("SELECT scope, status FROM findings").get() }, { scope: "project", status: "open" });
  assert.equal(store.listDueJobs(10).length, 0);

  await webhook("opened", { ...pull(2, false), state: "open" });
  await webhook("closed", pull(2, false));
  assert.equal(store.listDueJobs(10).length, 0);
  await webhook("opened", { ...pull(3, false), state: "open" });
  await webhook("synchronize", { ...pull(3, false), state: "open", head: { sha: "second", ref: "work" } });
  await webhook("closed", { ...pull(3), head: { sha: "second", ref: "work" } });
  db.prepare("UPDATE review_jobs SET run_after = datetime('now') WHERE status = 'queued'").run();
  assert.equal((await runNext()).headSha, "second");
  assert.equal(comments.length, 2);

  await recoverPrivateMerges(project, 1, "test");
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
  const beforeMerge = comments.length;
  await webhook("closed", pull(5));
  assert.equal(comments.length, beforeMerge);
  assert.equal(store.getPullRequest(early.prId)?.mergedIntoDefault, true);
  assert.equal(db.prepare("SELECT scope FROM findings WHERE pull_request_id = ?").get(early.prId)?.scope, "project");

  assert.equal(store.enqueueOverviewJob(project.id, { reason: "manual" }, true), "queued");
  const [overview] = store.listDueJobs(1);
  assert.ok(store.markJobRunning(overview.id));
  assert.equal(store.enqueueOverviewJob(project.id, { reason: "merge" }, true, true), "queued");
  assert.equal(store.enqueueOverviewJob(project.id, { reason: "merge" }, true, true), "active");
  console.log("Private setup, fast merge, late/duplicate delivery, recovery, scope and manual retry passed.");
} finally {
  globalThis.fetch = realFetch;
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 4 });
}
