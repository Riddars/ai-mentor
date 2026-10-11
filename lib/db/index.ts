import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "@/lib/config";
import type { FindingLocation } from "@/lib/curator/finding";
import { findingScope, type ChangedLines } from "@/lib/curator/scope";
import { priceRub } from "@/lib/llm/prices";

// Единственная точка доступа к SQLite. node:sqlite — встроенный драйвер (Node 22+,
// помечен experimental). Весь остальной код ходит в БД только через getDb() и
// репозиторий lib/curator/store.ts: если драйвер понадобится заменить, правка —
// здесь и только здесь. См. docs/документация/принятые решения.md.

// Схема данных этапа 3 (память проекта). DDL идемпотентный: выполняется при каждом
// открытии, CREATE ... IF NOT EXISTS ничего не ломает на уже созданной базе.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY,
  owner      TEXT NOT NULL,
  repo       TEXT NOT NULL,
  name       TEXT,
  status     TEXT NOT NULL DEFAULT 'active',
  github_repo_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner, repo)
);

CREATE TABLE IF NOT EXISTS participants (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  github_login  TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, github_login)
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  number      INTEGER NOT NULL,
  author_login TEXT,
  title       TEXT,
  state       TEXT,
  head_sha    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, number)
);

CREATE TABLE IF NOT EXISTS analyses (
  id               INTEGER PRIMARY KEY,
  pull_request_id  INTEGER NOT NULL REFERENCES pull_requests(id),
  head_sha         TEXT NOT NULL,
  trigger          TEXT NOT NULL,
  outcome          TEXT NOT NULL,
  summary          TEXT,
  provider         TEXT,
  model            TEXT,
  comment          TEXT,
  materials        TEXT,
  raw_response     TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS findings (
  id                INTEGER PRIMARY KEY,
  pull_request_id   INTEGER NOT NULL REFERENCES pull_requests(id),
  area              TEXT,
  severity          TEXT,
  title             TEXT NOT NULL,
  description       TEXT,
  locations         TEXT,
  verify            TEXT,
  evidence          TEXT,
  impact            TEXT,
  recommendation    TEXT,
  status            TEXT NOT NULL DEFAULT 'open',
  resolved_by_pr_id INTEGER REFERENCES pull_requests(id),
  first_analysis_id INTEGER REFERENCES analyses(id),
  last_analysis_id  INTEGER REFERENCES analyses(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS finding_status_history (
  id          INTEGER PRIMARY KEY,
  finding_id  INTEGER NOT NULL REFERENCES findings(id),
  old_status  TEXT,
  new_status  TEXT NOT NULL,
  reason      TEXT,
  analysis_id INTEGER REFERENCES analyses(id),
  actor       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS student_responses (
  id              INTEGER PRIMARY KEY,
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
  finding_id      INTEGER REFERENCES findings(id),
  github_login    TEXT,
  comment_id      INTEGER NOT NULL,
  body            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (comment_id)
);

CREATE TABLE IF NOT EXISTS github_events (
  id          INTEGER PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  event_type  TEXT,
  action      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (delivery_id)
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  login         TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL,
  name          TEXT,
  disabled      INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (login)
);

CREATE TABLE IF NOT EXISTS project_supervisors (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (project_id, user_id)
);

-- Queue of reviews. A commit job carries the id of its required check-run; the check is
-- concluded when the review is done, or earlier with a "not reviewed" note (deadline or
-- daily limit) while the job keeps retrying.
CREATE TABLE IF NOT EXISTS review_jobs (
  id              INTEGER PRIMARY KEY,
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
  kind            TEXT NOT NULL,
  head_sha        TEXT,
  check_run_id    INTEGER,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  attempts        INTEGER NOT NULL DEFAULT 0,
  run_after       TEXT NOT NULL DEFAULT (datetime('now')),
  deadline_at     TEXT,
  check_concluded INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS review_jobs_status ON review_jobs (status, run_after);
`;

let cached: DatabaseSync | null = null;

/** Соединение-синглтон. Живёт всё время процесса (долгоживущий next start). */
export function getDb(): DatabaseSync {
  if (cached) {
    return cached;
  }
  // turbopackIgnore: путь к БД — настраиваемый (DATABASE_PATH), а не ассет проекта;
  // без этого сборка трассирует весь проект в вывод сервера.
  const path = resolve(/* turbopackIgnore: true */ process.cwd(), databasePath());
  mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // WAL: состояние проекта пишут несколько путей по разным расписаниям (вебхук,
  // будущие обзор и сбор статистики) — WAL не даёт читателю блокировать писателя,
  // busy_timeout переживает короткие пересечения писателей. См. принятые решения.md.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);

  cached = db;
  return cached;
}

/**
 * Daily copy of the database next to it (`backups/curator-YYYY-MM-DD.db`), keeping the
 * `keep` most recent. A no-op when today's copy already exists.
 */
export function backupDatabase(keep = 7): void {
  const dir = resolve(process.cwd(), dirname(databasePath()), "backups");
  mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const target = join(dir, `curator-${today}.db`);
  if (existsSync(target)) return;
  getDb().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const copies = readdirSync(dir)
    .filter((f) => /^curator-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - keep))) {
    rmSync(join(dir, old));
  }
}

/** Column-level migrations that CREATE TABLE IF NOT EXISTS cannot express. */
function migrate(db: DatabaseSync): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (version < 3) {
    const columns = (
      db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    // Project lifecycle: active | paused | archived, replacing the earlier connected flag.
    if (!columns.includes("status")) {
      db.exec("ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    }
    if (columns.includes("connected")) {
      db.exec("ALTER TABLE projects DROP COLUMN connected");
    }
    db.exec("PRAGMA user_version = 3");
  }
  if (version < 4) {
    // Project lifecycle narrowed to active | paused; "archived" is folded into
    // paused (deliberate: archived projects become "on pause"). Deletion is now
    // a real delete (see панель руководителя.md).
    db.exec("UPDATE projects SET status = 'paused' WHERE status = 'archived'");
    db.exec("PRAGMA user_version = 4");
  }
  if (version < 5) {
    // Session revocation: the auth token carries the user's session_version and is
    // rejected once it changes (password change, account disabled).
    const columns = (
      db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!columns.includes("session_version")) {
      db.exec("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0");
    }
    db.exec("PRAGMA user_version = 5");
  }
  if (version < 6) {
    // Universal finding shape: a fixed area instead of free-text category, a list of
    // locations instead of a single file:lines, three severity levels. Analyses keep
    // the published comment and the materials the model was given.
    const findingColumns = (
      db.prepare("PRAGMA table_info(findings)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const column of ["area", "description", "locations"]) {
      if (!findingColumns.includes(column)) {
        db.exec(`ALTER TABLE findings ADD COLUMN ${column} TEXT`);
      }
    }
    if (findingColumns.includes("file")) {
      db.exec(`UPDATE findings SET locations = json_array(json_object(
                 'kind', 'file', 'target', file, 'detail', lines))
               WHERE file IS NOT NULL AND locations IS NULL`);
      db.exec("ALTER TABLE findings DROP COLUMN file");
      db.exec("ALTER TABLE findings DROP COLUMN lines");
    }
    if (findingColumns.includes("category")) {
      db.exec("ALTER TABLE findings DROP COLUMN category");
    }
    db.exec(`UPDATE findings SET severity = CASE LOWER(severity)
               WHEN 'high' THEN 'critical'
               WHEN 'medium' THEN 'important'
               WHEN 'low' THEN 'info'
               ELSE severity END`);

    const analysisColumns = (
      db.prepare("PRAGMA table_info(analyses)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const column of ["comment", "materials"]) {
      if (!analysisColumns.includes(column)) {
        db.exec(`ALTER TABLE analyses ADD COLUMN ${column} TEXT`);
      }
    }
    db.exec("PRAGMA user_version = 6");
  }
  if (version < 7) {
    // Stable GitHub repository id (renames keep the link), head of each PR, the PR whose
    // merge finalises a fix, who made a status change (null = the model), and the raw
    // model answer of each analysis.
    addColumns(db, "projects", { github_repo_id: "INTEGER" });
    addColumns(db, "pull_requests", { head_sha: "TEXT" });
    addColumns(db, "findings", { resolved_by_pr_id: "INTEGER REFERENCES pull_requests(id)" });
    addColumns(db, "finding_status_history", { actor: "TEXT" });
    addColumns(db, "analyses", { raw_response: "TEXT" });
    db.exec("PRAGMA user_version = 7");
  }
  if (version < 8) {
    // How to check that a finding is fixed: set when the finding is created, like its title.
    addColumns(db, "findings", { verify: "TEXT" });
    db.exec("PRAGMA user_version = 8");
  }
  if (version < 9) {
    // How an analysis was made and what it cost; the scope of a finding (the main branch
    // or only its PR's branch) and the branch it was raised on; the branches of a PR.
    addColumns(db, "analyses", {
      mode: "TEXT",
      tokens_in: "INTEGER",
      tokens_out: "INTEGER",
      viewed_files: "TEXT",
    });
    addColumns(db, "findings", { scope: "TEXT NOT NULL DEFAULT 'project'", branch: "TEXT" });
    addColumns(db, "pull_requests", {
      base_ref: "TEXT",
      head_ref: "TEXT",
      merged_into_default: "INTEGER NOT NULL DEFAULT 0",
    });
    // The base branch was not stored before: merged PRs are taken as merged into the main one.
    db.exec("UPDATE pull_requests SET merged_into_default = 1 WHERE state = 'merged'");
    // Findings of unmerged PRs, by the files of the analysis that raised them (lines unknown).
    const rows = db
      .prepare(
        `SELECT f.id, f.locations, a.materials FROM findings f
         JOIN pull_requests pr ON pr.id = f.pull_request_id
         LEFT JOIN analyses a ON a.id = f.first_analysis_id
         WHERE COALESCE(pr.state, 'open') != 'merged'`,
      )
      .all() as Array<{ id: number; locations: string | null; materials: string | null }>;
    const setBranch = db.prepare("UPDATE findings SET scope = 'branch' WHERE id = @id");
    for (const row of rows) {
      const files = parseJsonOr<{ files?: string[] }>(row.materials, {}).files ?? [];
      const changed: ChangedLines = new Map(files.map((f) => [f, null]));
      const locations = parseJsonOr<FindingLocation[]>(row.locations, []);
      if (findingScope(locations, changed, false) === "branch") setBranch.run({ id: row.id });
    }
    db.exec("PRAGMA user_version = 9");
  }
  if (version < 10) {
    // Rubles an analysis cost, priced when it was made (null: a model without a price);
    // top-ups and balances read from a provider's account, for the approximate balance.
    addColumns(db, "analyses", { cost_rub: "REAL" });
    // Earlier analyses are priced at the current prices; unknown ones count as free, so the
    // spend page does not flag the whole history as unpriced.
    const old = db
      .prepare(
        `SELECT id, provider, model, COALESCE(tokens_in, 0) AS input, COALESCE(tokens_out, 0) AS output
         FROM analyses WHERE cost_rub IS NULL`,
      )
      .all() as Array<{ id: number; provider: string | null; model: string | null; input: number; output: number }>;
    const setCost = db.prepare("UPDATE analyses SET cost_rub = @cost WHERE id = @id");
    for (const row of old) {
      const model = (row.model ?? "").replace(/ \(agent\)$/, "");
      const cost = row.provider ? priceRub(row, row.provider, model) : null;
      setCost.run({ id: row.id, cost: cost ?? 0 });
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS balance_entries (
        id          INTEGER PRIMARY KEY,
        provider    TEXT NOT NULL,
        kind        TEXT NOT NULL,
        amount_rub  REAL NOT NULL,
        at          TEXT NOT NULL,
        actor       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec("PRAGMA user_version = 10");
  }
}

function parseJsonOr<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function addColumns(db: DatabaseSync, table: string, columns: Record<string, string>): void {
  const existing = (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.includes(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}
