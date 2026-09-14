import { getDb } from "@/lib/db";

// Репозиторий памяти проекта (этап 3). Тонкие функции над getDb(); никакой SQL за
// пределами этого файла и lib/db/index.ts. Работает синхронно — node:sqlite
// синхронный, а разбор PR всё равно фоновая разовая задача.

export type FindingStatus = "open" | "closed" | "dismissed" | "reopened" | "pending";

/** Находка в том виде, в каком её отдаём модели для сверки (без объёмных текстов). */
export interface PriorFinding {
  id: number;
  category: string | null;
  severity: string | null;
  title: string;
  file: string | null;
  lines: string | null;
  status: FindingStatus;
}

export interface StudentResponse {
  findingId: number | null;
  login: string | null;
  body: string | null;
  createdAt: string;
}

/** Одна находка из ответа модели после сверки с прошлым состоянием. */
export interface ReconciledFinding {
  priorId: number | null;
  status: FindingStatus;
  category?: string | null;
  severity?: string | null;
  title: string;
  file?: string | null;
  lines?: string | null;
  evidence?: string | null;
  impact?: string | null;
  recommendation?: string | null;
  reason?: string | null;
}

export interface ReconcileResult {
  summary: string;
  findings: ReconciledFinding[];
}

/** active — в работе; paused — разбор отключён, проект остаётся в памяти. */
export type ProjectStatus = "active" | "paused";

export type PullRequestState = "open" | "merged" | "closed";

export type AnalysisOutcome = "ok" | "parse_error" | "error";

/** A project row with the aggregates the overview table shows. */
export interface ProjectSummary {
  id: number;
  owner: string;
  repo: string;
  name: string | null;
  status: ProjectStatus;
  participants: string[];
  /** Logins of the supervisors overseeing this project (shown to the head). */
  supervisors: string[];
  /** Open findings, excluding those in PRs closed without merge. */
  openFindings: number;
  seriousOpenFindings: number;
  oldestSeriousOpenAt: string | null;
  /** Latest PR update or analysis — the last thing the curator saw. */
  lastActivityAt: string | null;
  lastAnalysisAt: string | null;
  lastAnalysisOutcome: AnalysisOutcome | null;
  lastAnalysisTrigger: string | null;
  /** Open PRs whose latest commit analysis failed — their merge stays blocked. */
  blockedPrs: number;
}

export interface ProjectDetail {
  id: number;
  owner: string;
  repo: string;
  name: string | null;
  status: ProjectStatus;
}

export interface FindingRow {
  id: number;
  pullRequestId: number;
  prNumber: number | null;
  prState: PullRequestState | null;
  category: string | null;
  severity: string | null;
  title: string;
  file: string | null;
  lines: string | null;
  evidence: string | null;
  impact: string | null;
  recommendation: string | null;
  status: FindingStatus;
  /** Reason recorded with the latest status change, if any. */
  lastReason: string | null;
  /** When the finding was last reopened (from history), if ever. */
  reopenedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisRow {
  id: number;
  prNumber: number | null;
  headSha: string;
  trigger: string;
  outcome: AnalysisOutcome;
  summary: string | null;
  createdAt: string;
}

export interface PullRequestRow {
  id: number;
  number: number;
  title: string | null;
  author: string | null;
  state: PullRequestState | null;
  updatedAt: string;
  lastAnalysisAt: string | null;
  lastAnalysisOutcome: AnalysisOutcome | null;
  lastAnalysisTrigger: string | null;
  /** Open PR whose latest commit analysis failed: the check-run stays action_required. */
  blocked: boolean;
  openFindings: number;
  totalFindings: number;
  responses: number;
}

export interface StatusHistoryRow {
  oldStatus: FindingStatus | null;
  newStatus: FindingStatus;
  reason: string | null;
  createdAt: string;
}

const PARTICIPANTS_SQL = `
  SELECT github_login FROM participants WHERE project_id = @id ORDER BY first_seen_at`;

const OPEN_STATUSES = "('open', 'reopened', 'pending')";

/** A column of the latest analysis of `pr`, as a correlated subquery fragment. */
function lastAnalysis(column: string, where = ""): string {
  return `(SELECT ${column} FROM analyses WHERE pull_request_id = pr.id ${where}
     ORDER BY created_at DESC, id DESC LIMIT 1)`;
}

/**
 * Only a failed COMMIT analysis leaves the check-run at action_required; a failed
 * comment reconciliation creates no check-run. Closed/merged PRs cannot be blocked.
 */
const BLOCKED_SQL = `(COALESCE(pr.state, 'open') = 'open'
   AND ${lastAnalysis("outcome", "AND trigger = 'commit'")} = 'error')`;

// --- Scope ---
//
// Overview queries are optionally scoped to one supervisor: passing a supervisorId
// restricts them to that supervisor's projects, which is how the panel keeps a
// project supervisor from seeing other projects. The scope is expressed once, as
// a subquery of project ids.

interface Scope {
  projectIds: string;
  params: Record<string, string>;
}

function scope(supervisorId?: string): Scope {
  if (supervisorId) {
    return {
      projectIds: `SELECT p.id FROM projects p
        JOIN project_supervisors ps ON ps.project_id = p.id
        WHERE ps.user_id = @supervisorId`,
      params: { supervisorId },
    };
  }
  return { projectIds: "SELECT id FROM projects", params: {} };
}

// --- Overview ---

/** Projects with overview aggregates; optionally restricted to one supervisor. */
export function listProjectSummaries(supervisorId?: string): ProjectSummary[] {
  const db = getDb();
  const s = scope(supervisorId);
  const rows = db
    .prepare(
      `SELECT id, owner, repo, name, status FROM projects
       WHERE id IN (${s.projectIds}) ORDER BY name, repo`,
    )
    .all(s.params) as unknown as ProjectDetail[];

  return rows.map((p) => {
    const participants = (
      db.prepare(PARTICIPANTS_SQL).all({ id: p.id }) as Array<{ github_login: string }>
    ).map((r) => r.github_login);

    const supervisors = (
      db
        .prepare(
          `SELECT u.login FROM project_supervisors ps
             JOIN users u ON u.id = ps.user_id
             WHERE ps.project_id = @id ORDER BY u.login`,
        )
        .all({ id: p.id }) as Array<{ login: string }>
    ).map((r) => r.login);

    // Findings in PRs closed without merge never reached the main branch, so they
    // are not "open" for the project (see принятые решения.md).
    const counts = db
      .prepare(
        `SELECT
           COUNT(*) AS openFindings,
           SUM(CASE WHEN LOWER(f.severity) IN ('high', 'critical') THEN 1 ELSE 0 END) AS serious,
           MIN(CASE WHEN LOWER(f.severity) IN ('high', 'critical') THEN f.created_at END) AS oldestSerious
         FROM findings f
         JOIN pull_requests pr ON pr.id = f.pull_request_id
         WHERE pr.project_id = @id
           AND f.status IN ${OPEN_STATUSES}
           AND COALESCE(pr.state, 'open') != 'closed'`,
      )
      .get({ id: p.id }) as {
      openFindings: number;
      serious: number | null;
      oldestSerious: string | null;
    };

    const activity = db
      .prepare(
        `SELECT MAX(ts) AS lastActivityAt FROM (
           SELECT MAX(updated_at) AS ts FROM pull_requests WHERE project_id = @id
           UNION ALL
           SELECT MAX(a.created_at) AS ts FROM analyses a
             JOIN pull_requests pr ON pr.id = a.pull_request_id
             WHERE pr.project_id = @id
         )`,
      )
      .get({ id: p.id }) as { lastActivityAt: string | null };

    const last = db
      .prepare(
        `SELECT a.created_at AS at, a.outcome AS outcome, a.trigger AS trigger
         FROM analyses a JOIN pull_requests pr ON pr.id = a.pull_request_id
         WHERE pr.project_id = @id
         ORDER BY a.created_at DESC, a.id DESC LIMIT 1`,
      )
      .get({ id: p.id }) as { at: string; outcome: AnalysisOutcome; trigger: string } | undefined;

    const blocked = db
      .prepare(
        `SELECT COUNT(*) AS n FROM pull_requests pr
         WHERE pr.project_id = @id AND ${BLOCKED_SQL}`,
      )
      .get({ id: p.id }) as { n: number };

    return {
      id: p.id,
      owner: p.owner,
      repo: p.repo,
      name: p.name,
      status: p.status,
      participants,
      supervisors,
      openFindings: counts.openFindings,
      seriousOpenFindings: counts.serious ?? 0,
      oldestSeriousOpenAt: counts.oldestSerious,
      lastActivityAt: activity.lastActivityAt,
      lastAnalysisAt: last?.at ?? null,
      lastAnalysisOutcome: last?.outcome ?? null,
      lastAnalysisTrigger: last?.trigger ?? null,
      blockedPrs: blocked.n,
    };
  });
}

/**
 * Analysis timestamps of the last `weeks` weeks for every project in scope, in one
 * query. The caller buckets them per project into a weekly series.
 */
export function recentAnalysisTimestampsByProject(
  weeks: number,
  supervisorId?: string,
): Array<{ projectId: number; ts: string }> {
  const s = scope(supervisorId);
  return getDb()
    .prepare(
      `SELECT pr.project_id AS projectId, a.created_at AS ts
       FROM analyses a
       JOIN pull_requests pr ON pr.id = a.pull_request_id
       WHERE pr.project_id IN (${s.projectIds})
         AND a.created_at >= datetime('now', @since)`,
    )
    .all({ ...s.params, since: `-${weeks * 7} days` }) as Array<{
    projectId: number;
    ts: string;
  }>;
}

// --- Project page ---

export function getProject(id: number): ProjectDetail | null {
  const row = getDb()
    .prepare("SELECT id, owner, repo, name, status FROM projects WHERE id = @id")
    .get({ id }) as ProjectDetail | undefined;
  return row ?? null;
}

export function getProjectByRepo(owner: string, repo: string): ProjectDetail | null {
  const row = getDb()
    .prepare(
      `SELECT id, owner, repo, name, status FROM projects
       WHERE owner = @owner COLLATE NOCASE AND repo = @repo COLLATE NOCASE`,
    )
    .get({ owner, repo }) as ProjectDetail | undefined;
  return row ?? null;
}

export function getProjectParticipants(id: number): string[] {
  return (
    getDb().prepare(PARTICIPANTS_SQL).all({ id }) as Array<{ github_login: string }>
  ).map((r) => r.github_login);
}

const FINDING_SELECT = `
  SELECT f.id, f.pull_request_id AS pullRequestId, pr.number AS prNumber, pr.state AS prState,
         pr.project_id AS projectId, f.category, f.severity, f.title, f.file, f.lines,
         f.evidence, f.impact, f.recommendation, f.status,
         (SELECT h.reason FROM finding_status_history h WHERE h.finding_id = f.id
            ORDER BY h.created_at DESC, h.id DESC LIMIT 1) AS lastReason,
         (SELECT h.created_at FROM finding_status_history h WHERE h.finding_id = f.id
            AND h.new_status = 'reopened' ORDER BY h.created_at DESC, h.id DESC LIMIT 1) AS reopenedAt,
         f.created_at AS createdAt, f.updated_at AS updatedAt
  FROM findings f
  JOIN pull_requests pr ON pr.id = f.pull_request_id`;

export function listProjectFindings(projectId: number): FindingRow[] {
  return getDb()
    .prepare(`${FINDING_SELECT} WHERE pr.project_id = @projectId ORDER BY f.updated_at DESC`)
    .all({ projectId }) as unknown as FindingRow[];
}

export function getFinding(id: number): (FindingRow & { projectId: number }) | null {
  const row = getDb()
    .prepare(`${FINDING_SELECT} WHERE f.id = @id`)
    .get({ id }) as (FindingRow & { projectId: number }) | undefined;
  return row ?? null;
}

export function getFindingHistory(findingId: number): StatusHistoryRow[] {
  return getDb()
    .prepare(
      `SELECT old_status AS oldStatus, new_status AS newStatus, reason, created_at AS createdAt
       FROM finding_status_history WHERE finding_id = @findingId ORDER BY created_at, id`,
    )
    .all({ findingId }) as unknown as StatusHistoryRow[];
}

export function countProjectAnalyses(projectId: number): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM analyses a
       JOIN pull_requests pr ON pr.id = a.pull_request_id WHERE pr.project_id = @projectId`,
    )
    .get({ projectId }) as { n: number };
  return row.n;
}

export function listProjectAnalyses(projectId: number, limit = 20): AnalysisRow[] {
  return getDb()
    .prepare(
      `SELECT a.id, pr.number AS prNumber, a.head_sha AS headSha, a.trigger, a.outcome,
              a.summary, a.created_at AS createdAt
       FROM analyses a
       JOIN pull_requests pr ON pr.id = a.pull_request_id
       WHERE pr.project_id = @projectId
       ORDER BY a.created_at DESC, a.id DESC LIMIT @limit`,
    )
    .all({ projectId, limit }) as unknown as AnalysisRow[];
}

export function listProjectPullRequests(projectId: number): PullRequestRow[] {
  return (getDb()
    .prepare(
      `SELECT pr.id, pr.number, pr.title, pr.author_login AS author, pr.state,
              pr.updated_at AS updatedAt,
              ${lastAnalysis("created_at")} AS lastAnalysisAt,
              ${lastAnalysis("outcome")} AS lastAnalysisOutcome,
              ${lastAnalysis("trigger")} AS lastAnalysisTrigger,
              ${BLOCKED_SQL} AS blocked,
              (SELECT COUNT(*) FROM findings f WHERE f.pull_request_id = pr.id
                 AND f.status IN ${OPEN_STATUSES}) AS openFindings,
              (SELECT COUNT(*) FROM findings f WHERE f.pull_request_id = pr.id) AS totalFindings,
              (SELECT COUNT(*) FROM student_responses r WHERE r.pull_request_id = pr.id) AS responses
       FROM pull_requests pr
       WHERE pr.project_id = @projectId
       ORDER BY pr.updated_at DESC, pr.number DESC`,
    )
    .all({ projectId }) as unknown as Array<Omit<PullRequestRow, "blocked"> & { blocked: number }>)
    .map((r) => ({ ...r, blocked: r.blocked === 1 }));
}

// --- Admin: projects ---

export function createProjectManual(
  owner: string,
  repo: string,
  name?: string,
): number {
  return upsertProject(owner, repo, name);
}

/** All fields are always bound — node:sqlite rejects unused named parameters. */
export function updateProject(
  id: number,
  fields: { owner: string; repo: string; name: string | null },
): void {
  getDb()
    .prepare(
      `UPDATE projects SET owner = @owner, repo = @repo, name = @name,
         updated_at = datetime('now') WHERE id = @id`,
    )
    .run({ id, owner: fields.owner, repo: fields.repo, name: fields.name });
}

export function projectHasPullRequests(id: number): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM pull_requests WHERE project_id = @id LIMIT 1")
    .get({ id });
  return row !== undefined;
}

/**
 * Delete a project with everything the memory holds about it, in one transaction.
 * Order follows the foreign keys (PRAGMA foreign_keys = ON): history → responses →
 * findings → analyses → pull requests → participants → assignments → project.
 * github_events are not tied to a project and stay.
 */
export function deleteProjectCascade(id: number): void {
  const db = getDb();
  const steps = [
    `DELETE FROM finding_status_history WHERE finding_id IN
       (SELECT f.id FROM findings f JOIN pull_requests pr ON pr.id = f.pull_request_id
        WHERE pr.project_id = @id)`,
    `DELETE FROM student_responses WHERE pull_request_id IN
       (SELECT id FROM pull_requests WHERE project_id = @id)`,
    `DELETE FROM findings WHERE pull_request_id IN
       (SELECT id FROM pull_requests WHERE project_id = @id)`,
    `DELETE FROM analyses WHERE pull_request_id IN
       (SELECT id FROM pull_requests WHERE project_id = @id)`,
    `DELETE FROM pull_requests WHERE project_id = @id`,
    `DELETE FROM participants WHERE project_id = @id`,
    `DELETE FROM project_supervisors WHERE project_id = @id`,
    `DELETE FROM projects WHERE id = @id`,
  ];
  db.exec("BEGIN");
  try {
    for (const sql of steps) db.prepare(sql).run({ id });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function setProjectStatus(id: number, status: ProjectStatus): void {
  getDb()
    .prepare(
      "UPDATE projects SET status = @status, updated_at = datetime('now') WHERE id = @id",
    )
    .run({ id, status });
}

export function assignSupervisor(projectId: number, userId: string): void {
  getDb()
    .prepare(
      `INSERT INTO project_supervisors (project_id, user_id) VALUES (@projectId, @userId)
       ON CONFLICT (project_id, user_id) DO NOTHING`,
    )
    .run({ projectId, userId });
}

export function unassignSupervisor(projectId: number, userId: string): void {
  getDb()
    .prepare(
      "DELETE FROM project_supervisors WHERE project_id = @projectId AND user_id = @userId",
    )
    .run({ projectId, userId });
}

/** User ids of the supervisors assigned to a project. */
export function listProjectSupervisors(projectId: number): string[] {
  return (
    getDb()
      .prepare("SELECT user_id FROM project_supervisors WHERE project_id = @projectId")
      .all({ projectId }) as Array<{ user_id: string }>
  ).map((r) => r.user_id);
}

export function isSupervisorOf(userId: string, projectId: number): boolean {
  const row = getDb()
    .prepare(
      "SELECT 1 FROM project_supervisors WHERE project_id = @projectId AND user_id = @userId",
    )
    .get({ projectId, userId });
  return row !== undefined;
}

export function listAllProjects(): ProjectDetail[] {
  return getDb()
    .prepare("SELECT id, owner, repo, name, status FROM projects ORDER BY name, repo")
    .all() as unknown as ProjectDetail[];
}

// --- Curator write path (webhook / review.ts) ---

export function upsertProject(owner: string, repo: string, name?: string): number {
  const db = getDb();
  const row = db
    .prepare(
      `INSERT INTO projects (owner, repo, name) VALUES (@owner, @repo, @name)
       ON CONFLICT (owner, repo) DO UPDATE SET
         name = COALESCE(@name, projects.name),
         updated_at = datetime('now')
       RETURNING id`,
    )
    .get({ owner, repo, name: name ?? null }) as { id: number };
  return row.id;
}

export function upsertParticipant(projectId: number, login: string): void {
  getDb()
    .prepare(
      `INSERT INTO participants (project_id, github_login) VALUES (@projectId, @login)
       ON CONFLICT (project_id, github_login) DO NOTHING`,
    )
    .run({ projectId, login });
}

export function upsertPullRequest(
  projectId: number,
  number: number,
  info: { author?: string | null; title?: string | null; state?: PullRequestState | null } = {},
): number {
  const db = getDb();
  const row = db
    .prepare(
      `INSERT INTO pull_requests (project_id, number, author_login, title, state)
       VALUES (@projectId, @number, @author, @title, @state)
       ON CONFLICT (project_id, number) DO UPDATE SET
         author_login = COALESCE(@author, pull_requests.author_login),
         title = COALESCE(@title, pull_requests.title),
         state = COALESCE(@state, pull_requests.state),
         updated_at = datetime('now')
       RETURNING id`,
    )
    .get({
      projectId,
      number,
      author: info.author ?? null,
      title: info.title ?? null,
      state: info.state ?? null,
    }) as { id: number };
  return row.id;
}

/** Forget a delivery so GitHub's retry of a failed handling is not treated as a duplicate. */
export function forgetEvent(deliveryId: string): void {
  getDb().prepare("DELETE FROM github_events WHERE delivery_id = @deliveryId").run({ deliveryId });
}

/**
 * Записать факт доставки вебхука. false — если delivery уже видели (повторная
 * доставка GitHub): обработчик должен молча выйти. Идемпотентность на входе.
 */
export function recordEventOnce(
  deliveryId: string,
  eventType: string | null,
  action: string | null,
): boolean {
  const res = getDb()
    .prepare(
      `INSERT INTO github_events (delivery_id, event_type, action)
       VALUES (@deliveryId, @eventType, @action)
       ON CONFLICT (delivery_id) DO NOTHING`,
    )
    .run({ deliveryId, eventType, action });
  return res.changes > 0;
}

/** Уже был удачный разбор этого коммита? Защита от повторного разбора того же head. */
export function hasSuccessfulCommitAnalysis(prId: number, headSha: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM analyses
       WHERE pull_request_id = @prId AND head_sha = @headSha
         AND trigger = 'commit' AND outcome = 'ok'
       LIMIT 1`,
    )
    .get({ prId, headSha });
  return row !== undefined;
}

export function recordAnalysis(params: {
  prId: number;
  headSha: string;
  trigger: "commit" | "comment";
  outcome: AnalysisOutcome;
  summary?: string | null;
  provider?: string | null;
  model?: string | null;
}): number {
  const row = getDb()
    .prepare(
      `INSERT INTO analyses (pull_request_id, head_sha, trigger, outcome, summary, provider, model)
       VALUES (@prId, @headSha, @trigger, @outcome, @summary, @provider, @model)
       RETURNING id`,
    )
    .get({
      prId: params.prId,
      headSha: params.headSha,
      trigger: params.trigger,
      outcome: params.outcome,
      summary: params.summary ?? null,
      provider: params.provider ?? null,
      model: params.model ?? null,
    }) as { id: number };
  return row.id;
}

export function loadOpenFindings(prId: number): PriorFinding[] {
  return getDb()
    .prepare(
      `SELECT id, category, severity, title, file, lines, status
       FROM findings
       WHERE pull_request_id = @prId AND status IN ${OPEN_STATUSES}
       ORDER BY id`,
    )
    .all({ prId }) as unknown as PriorFinding[];
}

export function loadStudentResponses(prId: number): StudentResponse[] {
  return getDb()
    .prepare(
      `SELECT finding_id AS findingId, github_login AS login, body, created_at AS createdAt
       FROM student_responses
       WHERE pull_request_id = @prId
       ORDER BY created_at`,
    )
    .all({ prId }) as unknown as StudentResponse[];
}

/**
 * Сохранить ответ студента. false — если этот комментарий уже сохранён (дедуп по
 * comment_id): вызывающий не должен запускать сверку повторно.
 */
export function saveStudentResponse(params: {
  prId: number;
  commentId: number;
  login?: string | null;
  body?: string | null;
  findingId?: number | null;
}): boolean {
  const res = getDb()
    .prepare(
      `INSERT INTO student_responses (pull_request_id, finding_id, github_login, comment_id, body)
       VALUES (@prId, @findingId, @login, @commentId, @body)
       ON CONFLICT (comment_id) DO NOTHING`,
    )
    .run({
      prId: params.prId,
      findingId: params.findingId ?? null,
      login: params.login ?? null,
      commentId: params.commentId,
      body: params.body ?? null,
    });
  return res.changes > 0;
}

export interface StatusChange {
  findingId: number;
  title: string;
  oldStatus: FindingStatus | null;
  newStatus: FindingStatus;
  reason: string | null;
}

/**
 * Применить результат сверки модели: создать новые находки, обновить существующие,
 * записать историю смены статусов. Всё в одной транзакции. Находки, которых модель
 * не упомянула, не трогаем (консервативно оставляем как есть). Возвращает смены
 * статусов — вызывающий по ним решает, что написать в комментарии.
 */
export function applyReconciliation(
  prId: number,
  analysisId: number,
  result: ReconcileResult,
): { created: number; statusChanges: StatusChange[] } {
  const db = getDb();
  const statusChanges: StatusChange[] = [];
  let created = 0;

  const insertFinding = db.prepare(
    `INSERT INTO findings
       (pull_request_id, category, severity, title, file, lines, evidence, impact,
        recommendation, status, first_analysis_id, last_analysis_id)
     VALUES (@prId, @category, @severity, @title, @file, @lines, @evidence, @impact,
             @recommendation, @status, @analysisId, @analysisId)
     RETURNING id`,
  );
  const updateFinding = db.prepare(
    `UPDATE findings SET
       category = @category, severity = @severity, title = @title, file = @file,
       lines = @lines, evidence = @evidence, impact = @impact,
       recommendation = @recommendation, status = @status,
       last_analysis_id = @analysisId, updated_at = datetime('now')
     WHERE id = @id`,
  );
  const getFinding = db.prepare(
    `SELECT status, title FROM findings WHERE id = @id AND pull_request_id = @prId`,
  );
  const insertHistory = db.prepare(
    `INSERT INTO finding_status_history (finding_id, old_status, new_status, reason, analysis_id)
     VALUES (@findingId, @oldStatus, @newStatus, @reason, @analysisId)`,
  );

  db.exec("BEGIN");
  try {
    for (const f of result.findings) {
      const fields = {
        prId,
        analysisId,
        category: f.category ?? null,
        severity: f.severity ?? null,
        title: f.title,
        file: f.file ?? null,
        lines: f.lines ?? null,
        evidence: f.evidence ?? null,
        impact: f.impact ?? null,
        recommendation: f.recommendation ?? null,
        status: f.status,
      };

      if (f.priorId == null) {
        const row = insertFinding.get(fields) as { id: number };
        created += 1;
        insertHistory.run({
          findingId: row.id,
          oldStatus: null,
          newStatus: f.status,
          reason: f.reason ?? null,
          analysisId,
        });
        statusChanges.push({
          findingId: row.id,
          title: f.title,
          oldStatus: null,
          newStatus: f.status,
          reason: f.reason ?? null,
        });
        continue;
      }

      const prev = getFinding.get({ id: f.priorId, prId }) as
        | { status: FindingStatus; title: string }
        | undefined;
      if (!prev) {
        // Модель сослалась на несуществующий prior_id — считаем находку новой.
        const row = insertFinding.get(fields) as { id: number };
        created += 1;
        insertHistory.run({
          findingId: row.id,
          oldStatus: null,
          newStatus: f.status,
          reason: f.reason ?? null,
          analysisId,
        });
        statusChanges.push({
          findingId: row.id,
          title: f.title,
          oldStatus: null,
          newStatus: f.status,
          reason: f.reason ?? null,
        });
        continue;
      }

      // UPDATE не использует @prId — node:sqlite ругается на лишний параметр.
      const { prId: _prId, ...updateFields } = fields;
      void _prId;
      updateFinding.run({ ...updateFields, id: f.priorId });
      if (prev.status !== f.status) {
        insertHistory.run({
          findingId: f.priorId,
          oldStatus: prev.status,
          newStatus: f.status,
          reason: f.reason ?? null,
          analysisId,
        });
        statusChanges.push({
          findingId: f.priorId,
          title: f.title,
          oldStatus: prev.status,
          newStatus: f.status,
          reason: f.reason ?? null,
        });
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { created, statusChanges };
}
