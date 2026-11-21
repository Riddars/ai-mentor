/** Real queue entry point and SQLite checkpoints; ALL external calls are mocked. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Header } from "tar";

const directory = await mkdtemp(join(tmpdir(), "map-queue-test-"));
process.env.DATABASE_PATH = join(directory, "test.db");
Object.assign(process.env, { LLM_PROVIDER: "selectel", LLM_MODEL: "fixture", SELECTEL_API_KEY: "fixture", CURATOR_REVIEWER: "llm",
  INITIAL_OVERVIEW_MODE: "parts", INITIAL_MAP_CONTEXT_TOKENS: "16000", GITHUB_APP_ID: "123", GITHUB_WEBHOOK_SECRET: "test",
  GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" })).toString("base64") });
delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
delete process.env.LLM_FALLBACK_PROVIDER;
const { getDb } = await import("@/lib/db");
const { addProjectNotes, enqueueOverviewJob, getProjectNotes, listDueJobs, markJobRunning, upsertProject } = await import("@/lib/curator/store");
const { executeOverviewJob } = await import("@/lib/curator/overview");
const blocks: Buffer[] = [];
for (let i = 0; i < 8; i++) {
  const body = Buffer.from("x".repeat(7000));
  const header = Buffer.alloc(512);
  new Header({ path: `repo/file-${i}.ts`, type: "File", size: body.length, mode: 0o600 }).encode(header);
  blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
}
const archive = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
const notes = "### Суть\nПроект\n### Карта репозитория\nфайлы\n### Путь данных\nнет\n### Сознательные решения\nнет";
let calls = 0, successfulFirst = "", replayed = false, interrupt = true;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input)), path = url.pathname;
  if (path.endsWith("/installation")) return Response.json({ id: 7 });
  if (path.endsWith("/access_tokens")) return Response.json({ token: "fixture", expires_at: "2099-01-01T00:00:00Z" });
  if (path.endsWith("/repos/sample/project")) return Response.json({ default_branch: "main" });
  if (path.endsWith("/branches/main")) return Response.json({ commit: { sha: "a".repeat(40) } });
  if (path.includes("/tarball/")) return new Response(new Uint8Array(archive));
  if (path.endsWith("/chat/completions")) {
    const body = JSON.parse(String(init?.body)) as { messages: unknown };
    const key = JSON.stringify(body.messages); calls++;
    if (interrupt && calls === 2) throw new Error("simulated interruption");
    if (calls === 1) successfulFirst = key;
    else if (key === successfulFirst) replayed = true;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "map", findings: [], notes }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  }
  if (path.endsWith("/issues") && init?.method === "POST") return Response.json({ number: 1 });
  if (path.endsWith("/issues/1") && init?.method === "PATCH") return Response.json({});
  if (path.endsWith("/issues/1/lock")) return new Response(null, { status: 204 });
  throw new Error("Unmocked external request " + url.host + path);
};
try {
  const project = upsertProject("sample", "project");
  enqueueOverviewJob(project, { reason: "initial" }, true);
  let job = listDueJobs(1)[0];
  markJobRunning(job.id);
  await assert.rejects(executeOverviewJob({ ...job, attempts: 1 }), /interruption/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM context_pipeline_parts").get()?.n, 1);
  addProjectNotes(project, "human notes must survive", { actor: "supervisor" });
  process.env.INITIAL_OVERVIEW_MODE = "agent"; // A retry must keep the pinned pipeline.
  getDb().prepare("UPDATE review_jobs SET status='queued' WHERE id=?").run(job.id);
  job = listDueJobs(1)[0];
  assert.equal((job.payload as { initialMapMode: string }).initialMapMode, "parts");
  markJobRunning(job.id); interrupt = false;
  const outcome = await executeOverviewJob({ ...job, attempts: 2 });
  assert.equal(outcome.quality, "complete");
  assert.equal(replayed, false, "production retry reuses saved leaf despite checkpoint and new manual notes");
  assert.equal(getProjectNotes(project)?.body, "human notes must survive");
  console.log("ok real overview queue: SQLite checkpoints, stable retry task and mode, no repeated successful leaf, manual notes preserved");
} finally { getDb().close(); await rm(directory, { recursive: true, force: true }); }
