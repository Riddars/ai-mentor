import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getConfig } from "@/lib/config";

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
  connected  INTEGER NOT NULL DEFAULT 1,
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
`;

let cached: DatabaseSync | null = null;

/** Соединение-синглтон. Живёт всё время процесса (долгоживущий next start). */
export function getDb(): DatabaseSync {
  if (cached) {
    return cached;
  }
  // turbopackIgnore: путь к БД — настраиваемый (DATABASE_PATH), а не ассет проекта;
  // без этого сборка трассирует весь проект в вывод сервера.
  const path = resolve(/* turbopackIgnore: true */ process.cwd(), getConfig().databasePath);
  mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // WAL: состояние проекта пишут несколько путей по разным расписаниям (вебхук,
  // будущие обзор и сбор статистики) — WAL не даёт читателю блокировать писателя,
  // busy_timeout переживает короткие пересечения писателей. См. принятые решения.md.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  // Место под будущие миграции: сейчас единственная версия схемы — 1.
  db.exec("PRAGMA user_version = 1;");

  cached = db;
  return cached;
}
