/** Upgrade deployed v17 and the unpublished local v18 without opening a real database. */
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
  for (const [table, column] of [
    ["projects", "merged_sync_at"], ["projects", "activity_revision"], ["projects", "pause_reason"], ["pull_requests", "acknowledged"],
    ["review_jobs", "publication_body"], ["review_jobs", "publication_key"],
  ]) {
    assert.ok((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column));
  }
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 26);
  assert.equal(db.prepare("SELECT comment FROM analyses WHERE id = 1").get()?.comment, "existing review");
  assert.equal(db.prepare("SELECT overview_reason FROM analyses WHERE id = 1").get()?.overview_reason, "refresh");
  assert.equal(db.prepare("SELECT status FROM review_jobs WHERE id = 1").get()?.status, "queued");
  db.close();
} else {
  const dir = mkdtempSync(join(tmpdir(), "curator-review-migration-"));
  try {
    for (const version of [17, 18, 19]) {
      const path = join(dir, `v${version}.db`);
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE projects (id INTEGER PRIMARY KEY, created_at TEXT);
        CREATE TABLE pull_requests (id INTEGER PRIMARY KEY, state TEXT, number INTEGER, head_sha TEXT);
        CREATE TABLE review_jobs (id INTEGER PRIMARY KEY, status TEXT, run_after TEXT,
          published_analysis_id INTEGER);
        CREATE TABLE analyses (id INTEGER PRIMARY KEY, comment TEXT, pull_request_id INTEGER, head_sha TEXT,
          trigger TEXT, outcome TEXT, raw_response TEXT, overview_reason TEXT);
        INSERT INTO pull_requests VALUES (1, 'open', 3, 'current');
        INSERT INTO analyses VALUES (1, 'existing review', 1, 'current', 'commit', 'partial', '{"refreshOverview":"refresh"}', NULL);
        INSERT INTO review_jobs VALUES (1, 'queued', '2026-11-01', 1);
        PRAGMA user_version = ${version};
      `);
      if (version === 17 || version === 19) old.exec(`
        ALTER TABLE projects ADD COLUMN merged_sync_at TEXT;
        ALTER TABLE pull_requests ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0;
      `);
      if (version === 18 || version === 19) old.exec(`
        ALTER TABLE review_jobs ADD COLUMN publication_key TEXT;
        ALTER TABLE review_jobs ADD COLUMN publication_body TEXT;
      `);
      old.close();
      const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "child"], {
        env: { ...process.env, DATABASE_PATH: path }, encoding: "utf8",
      });
      assert.equal(child.status, 0, child.stdout + child.stderr);
      console.log(`ok version ${version} upgraded to 26, existing rows preserved`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
