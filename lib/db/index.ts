import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "@/lib/config";

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
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS findings (
  id                INTEGER PRIMARY KEY,
  pull_request_id   INTEGER NOT NULL REFERENCES pull_requests(id),
  category          TEXT,
  severity          TEXT,
  title             TEXT NOT NULL,
  file              TEXT,
  lines             TEXT,
  evidence          TEXT,
  impact            TEXT,
  recommendation    TEXT,
  status            TEXT NOT NULL DEFAULT 'open',
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
}
