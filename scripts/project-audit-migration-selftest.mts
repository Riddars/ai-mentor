import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "child") {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 26);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_maps'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='project_audit_automatic'").get());
  db.close();
} else {
  const directory = mkdtempSync(join(tmpdir(), "audit-migration-"));
  const run = (path: string) => spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "child"], {
    env: { ...process.env, DATABASE_PATH: path }, encoding: "utf8" });
  try {
    for (const partial of ["maps", "tables", "invalid-runs"]) {
      const path = join(directory, partial + ".db");
      let child = run(path); assert.equal(child.status, 0, child.stderr);
      let db = new DatabaseSync(path);
      db.exec("DROP INDEX project_audit_automatic; PRAGMA user_version=23;");
      if (partial === "maps") db.exec("DROP TABLE project_audit_runs");
      if (partial === "invalid-runs") db.exec("DROP TABLE project_audit_runs; DROP TABLE project_maps; CREATE TABLE project_audit_runs(job_id INTEGER PRIMARY KEY);");
      db.close();
      child = run(path);
      if (partial === "invalid-runs") {
        assert.notEqual(child.status, 0, "invalid preexisting schema must fail");
        db = new DatabaseSync(path);
        assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 23);
        assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_maps'").get(), undefined, "failed migration rolls back its new table");
        db.exec("DROP TABLE project_audit_runs"); db.close();
        child = run(path);
      }
      assert.equal(child.status, 0, child.stderr);
    }
    console.log("ok audit migration: interrupted v23 with one/both tables resumes; failed DDL rolls back schema and version atomically");
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); }
}
