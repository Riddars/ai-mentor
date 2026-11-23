/** Free diagnostics persistence checks against isolated fresh and v20 databases. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "child") {
  const { getDb } = await import("@/lib/db");
  const { recordJobEvent, saveAnalysisDiagnostics, getAnalysisDiagnostics, getJobDiagnostics } = await import("@/lib/curator/diagnostics");
  const db = getDb();
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 25);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_pipeline_parts'").get());
  if (process.argv[3] === "fresh") {
    db.exec(`INSERT INTO projects(id,owner,repo) VALUES(1,'test','diagnostics');
      INSERT INTO pull_requests(id,project_id,number) VALUES(1,1,0);
      INSERT INTO analyses(id,pull_request_id,head_sha,trigger,outcome,comment) VALUES(1,1,'head','overview','partial','legacy draft');
      INSERT INTO review_jobs(id,pull_request_id,kind,payload) VALUES(1,1,'overview','{}');`);
  }
  assert.equal(db.prepare("SELECT comment FROM analyses WHERE id=1").get()?.comment, "legacy draft");
  assert.equal(getAnalysisDiagnostics(1), null);
  assert.equal(getAnalysisDiagnostics(999), null);
  assert.equal(getJobDiagnostics(999), null);
  const context = { messages: [{ role: "user", content: "Я".repeat(200_000) }] };
  recordJobEvent(1, { type: "model_call_started", callId: "primary-1", phase: "research", context });
  let job = getJobDiagnostics(1)!;
  assert.deepEqual((job.events as Array<Record<string, unknown>>)[0].context, context, "actual context must be preserved without clipping");
  assert.equal((job.unknownInFlight as unknown[]).length, 1);
  recordJobEvent(1, { type: "model_call_finished", callId: "primary-1", usage: { input: 10, output: 2 } });
  recordJobEvent(1, { type: "model_call_started", callId: "primary-2", phase: "compact" });
  job = getJobDiagnostics(1)!;
  assert.equal((job.unknownInFlight as Array<Record<string, unknown>>)[0].callId, "primary-2");
  const diagnostics = { version: 1, reason: "tool_limit", calls: [{ phase: "research", provider: "test", usage: { input: 10, output: 2 } }], delivery: { state: "none" } };
  saveAnalysisDiagnostics(1, diagnostics);
  assert.deepEqual(getAnalysisDiagnostics(1), diagnostics);

  process.env.DIAGNOSTICS_MAX_EVENT_BYTES = "1000";
  recordJobEvent(1, { type: "model_call_started", callId: "large", context });
  const omitted = (getJobDiagnostics(1)!.events as Array<Record<string, unknown>>).at(-1)!;
  assert.equal(omitted.callId, "large");
  assert.equal((omitted.payloadOmitted as Record<string, unknown>).reason, "event_storage_limit");
  assert.equal(String((omitted.payloadOmitted as Record<string, unknown>).sha256).length, 64);
  delete process.env.DIAGNOSTICS_MAX_EVENT_BYTES;
  process.env.DIAGNOSTICS_MAX_JOB_BYTES = "1";
  recordJobEvent(1, { type: "model_call_finished", callId: "large", usage: { input: 30, output: 4 } });
  const terminal = (getJobDiagnostics(1)!.events as Array<Record<string, unknown>>).at(-1)!;
  assert.equal((terminal.payloadOmitted as Record<string, unknown>).reason, "job_storage_limit");
  assert.deepEqual(terminal.usage, { input: 30, output: 4 }, "storage limits must not hide known usage or terminal identity");
  assert.equal((getJobDiagnostics(1)!.unknownInFlight as unknown[]).length, 1);
  delete process.env.DIAGNOSTICS_MAX_JOB_BYTES;
  const backup = process.env.DATABASE_PATH! + ".backup";
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  const restored = new DatabaseSync(backup);
  assert.equal(restored.prepare("PRAGMA user_version").get()?.user_version, 25);
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM review_diagnostic_events").get()?.n, 5);
  assert.equal(restored.prepare("SELECT diagnostics_json FROM analyses WHERE id=1").get()?.diagnostics_json, JSON.stringify(diagnostics));
  restored.close();
  db.prepare("DELETE FROM review_jobs WHERE id=1").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM review_diagnostic_events").get()?.n, 0);
  db.close();
} else {
  const dir = mkdtempSync(join(tmpdir(), "curator-diagnostics-migration-"));
  try {
    for (const mode of ["fresh", "v20"]) {
      const path = join(dir, `${mode}.db`);
      if (mode === "v20") {
        const old = new DatabaseSync(path);
        old.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY);
          CREATE TABLE pull_requests(id INTEGER PRIMARY KEY);
          CREATE TABLE analyses(id INTEGER PRIMARY KEY, comment TEXT);
          CREATE TABLE review_jobs(id INTEGER PRIMARY KEY,status TEXT,run_after TEXT);
          INSERT INTO analyses VALUES(1,'legacy draft');
          INSERT INTO review_jobs VALUES(1,'queued','2026-11-20');
          PRAGMA user_version=20;`);
        old.close();
      }
      const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "child", mode], {
        env: { ...process.env, DATABASE_PATH: path }, encoding: "utf8",
      });
      assert.equal(child.status, 0, child.stdout + child.stderr);
      console.log(`ok ${mode}: diagnostics, full context, interrupted request, explicit storage limits, backup/restore, cascade`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
