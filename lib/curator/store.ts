import { getDb } from "@/lib/db";
import type { FindingArea, FindingLocation, Severity } from "@/lib/curator/finding";

// Репозиторий памяти проекта (этап 3). Тонкие функции над getDb(); никакой SQL за
// пределами этого файла и lib/db/index.ts. Работает синхронно — node:sqlite
// синхронный, а разбор PR всё равно фоновая разовая задача.

export type FindingStatus = "open" | "closed" | "dismissed" | "reopened" | "pending";

/** What the model was given for one analysis. */
export interface AnalysisMaterials {
  /** All changed files of the PR that were listed. */
  files: string[];
  /** Files left out of the prompt by the size limit (absent in older analyses). */
  omitted?: string[];
  /** Changed files beyond the listing limit. */
  unlisted?: number;
  researchDoc: boolean;
  planDoc?: boolean;
  truncated: boolean;
  /** Open findings of the project given to the model for reconciliation. */
  priorFindings: number;
  studentResponses: number;
}

/** Находка в том виде, в каком её отдаём модели для сверки (без объёмных текстов). */
export interface PriorFinding {
  id: number;
  /** Pull request the finding was raised in. */
  prNumber: number;
  area: FindingArea | null;
  severity: Severity | null;
  title: string;
  locations: FindingLocation[];
  /** How to check that the problem is fixed. */
  verify: string | null;
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
  area?: FindingArea | null;
  severity?: Severity | null;
  title: string;
  description?: string | null;
  locations?: FindingLocation[];
  verify?: string | null;
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

/** `stale`: the model answered, but the PR had moved on (new commit, closed) — not applied. */
export type AnalysisOutcome = "ok" | "parse_error" | "error" | "stale";

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
  /** PRs whose latest commit has no review yet although its check was concluded. */
  unreviewedPrs: number;
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
  area: FindingArea | null;
  severity: Severity | null;
  title: string;
  description: string | null;
  locations: FindingLocation[];
  verify: string | null;
  evidence: string | null;
  impact: string | null;
  recommendation: string | null;
  status: FindingStatus;
  /** Reason recorded with the latest status change, if any. */
  lastReason: string | null;
  /** When the finding was last reopened (from history), if ever. */
  reopenedAt: string | null;
  /** Commit of the latest analysis that touched the finding — locations point there. */
  headSha: string | null;
  /** PR whose diff showed the fix (pending) or whose merge closed it. */
  resolvedByPrNumber: number | null;
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

export interface AnalysisDetail extends AnalysisRow {
  projectId: number;
  provider: string | null;
  model: string | null;
  /** The comment published to the pull request, if any. */
  comment: string | null;
  materials: AnalysisMaterials | null;
  /** The model answer as received. */
  rawResponse: string | null;
}

/** A finding status change made by one analysis (a new finding has no old status). */
export interface AnalysisChange {
  findingId: number;
  /** Pull request the finding was raised in. */
  prNumber: number;
  title: string;
  oldStatus: FindingStatus | null;
  newStatus: FindingStatus;
  reason: string | null;
}

export interface StatusHistoryRow {
  oldStatus: FindingStatus | null;
  newStatus: FindingStatus;
  reason: string | null;
  /** Analysis that made the change and the PR it ran on (may differ from the finding's PR). */
  analysisId: number | null;
  prNumber: number | null;
  /** Login of the person who made the change; null when the model or the system did. */
  actor: string | null;
  createdAt: string;
}

const PARTICIPANTS_SQL = `
  SELECT github_login FROM participants WHERE project_id = @id ORDER BY first_seen_at`;

const OPEN_STATUSES = "('open', 'reopened', 'pending')";

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
           SUM(CASE WHEN f.severity = 'critical' THEN 1 ELSE 0 END) AS serious,
           MIN(CASE WHEN f.severity = 'critical' THEN f.created_at END) AS oldestSerious
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

    const last = db
      .prepare(
        `SELECT a.created_at AS at, a.outcome AS outcome, a.trigger AS trigger
         FROM analyses a JOIN pull_requests pr ON pr.id = a.pull_request_id
         WHERE pr.project_id = @id
         ORDER BY a.created_at DESC, a.id DESC LIMIT 1`,
      )
      .get({ id: p.id }) as { at: string; outcome: AnalysisOutcome; trigger: string } | undefined;


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
      lastActivityAt: getProjectLastActivity(p.id),
      lastAnalysisAt: last?.at ?? null,
      lastAnalysisOutcome: last?.outcome ?? null,
      lastAnalysisTrigger: last?.trigger ?? null,
      unreviewedPrs: countUnreviewedPrs(p.id),
    };
  });
}

/** Latest PR update or analysis of a project — the last thing the curator saw. */
export function getProjectLastActivity(projectId: number): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(ts) AS ts FROM (
         SELECT MAX(updated_at) AS ts FROM pull_requests WHERE project_id = @projectId
         UNION ALL
         SELECT MAX(a.created_at) AS ts FROM analyses a
           JOIN pull_requests pr ON pr.id = a.pull_request_id
           WHERE pr.project_id = @projectId
       )`,
    )
    .get({ projectId }) as { ts: string | null };
  return row.ts;
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

/**
 * Project of a webhook repository. Looks up by GitHub's stable repository id first, so a
 * renamed or transferred repository keeps its project (the stored name is refreshed);
 * falls back to owner/repo for projects that have not seen an event yet and remembers
 * the id.
 */
export function findProjectForRepository(
  repoId: number | null,
  owner: string,
  repo: string,
): ProjectDetail | null {
  const db = getDb();
  if (repoId !== null) {
    const byId = db
      .prepare("SELECT id, owner, repo, name, status FROM projects WHERE github_repo_id = @repoId")
      .get({ repoId }) as ProjectDetail | undefined;
    if (byId) {
      if (byId.owner !== owner || byId.repo !== repo) {
        db.prepare(
          "UPDATE projects SET owner = @owner, repo = @repo, updated_at = datetime('now') WHERE id = @id",
        ).run({ id: byId.id, owner, repo });
        return { ...byId, owner, repo };
      }
      return byId;
    }
  }
  const byName = getProjectByRepo(owner, repo);
  if (byName && repoId !== null) {
    db.prepare("UPDATE projects SET github_repo_id = @repoId WHERE id = @id").run({
      id: byName.id,
      repoId,
    });
  }
  return byName;
}

export function getProjectParticipants(id: number): string[] {
  return (
    getDb().prepare(PARTICIPANTS_SQL).all({ id }) as Array<{ github_login: string }>
  ).map((r) => r.github_login);
}

const FINDING_SELECT = `
  SELECT f.id, f.pull_request_id AS pullRequestId, pr.number AS prNumber, pr.state AS prState,
         pr.project_id AS projectId, f.area, f.severity, f.title, f.description, f.locations,
         f.verify,
         f.evidence, f.impact, f.recommendation, f.status,
         (SELECT h.reason FROM finding_status_history h WHERE h.finding_id = f.id
            ORDER BY h.created_at DESC, h.id DESC LIMIT 1) AS lastReason,
         (SELECT h.created_at FROM finding_status_history h WHERE h.finding_id = f.id
            AND h.new_status = 'reopened' ORDER BY h.created_at DESC, h.id DESC LIMIT 1) AS reopenedAt,
         (SELECT a.head_sha FROM analyses a WHERE a.id = f.last_analysis_id) AS headSha,
         (SELECT r.number FROM pull_requests r WHERE r.id = f.resolved_by_pr_id) AS resolvedByPrNumber,
         f.created_at AS createdAt, f.updated_at AS updatedAt
  FROM findings f
  JOIN pull_requests pr ON pr.id = f.pull_request_id`;

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

type RawFinding<T> = Omit<T, "locations"> & { locations: string | null };

function toFinding<T extends FindingRow>(row: RawFinding<T>): T {
  return { ...row, locations: parseJson<FindingLocation[]>(row.locations) ?? [] } as T;
}

export function listProjectFindings(projectId: number): FindingRow[] {
  const rows = getDb()
    .prepare(`${FINDING_SELECT} WHERE pr.project_id = @projectId ORDER BY f.updated_at DESC`)
    .all({ projectId }) as unknown as RawFinding<FindingRow>[];
  return rows.map(toFinding);
}

export function getFinding(id: number): (FindingRow & { projectId: number }) | null {
  const row = getDb()
    .prepare(`${FINDING_SELECT} WHERE f.id = @id`)
    .get({ id }) as RawFinding<FindingRow & { projectId: number }> | undefined;
  return row ? toFinding(row) : null;
}

export function getFindingHistory(findingId: number): StatusHistoryRow[] {
  return getDb()
    .prepare(
      `SELECT h.old_status AS oldStatus, h.new_status AS newStatus, h.reason,
              h.analysis_id AS analysisId, pr.number AS prNumber, h.actor,
              h.created_at AS createdAt
       FROM finding_status_history h
       LEFT JOIN analyses a ON a.id = h.analysis_id
       LEFT JOIN pull_requests pr ON pr.id = a.pull_request_id
       WHERE h.finding_id = @findingId ORDER BY h.created_at, h.id`,
    )
    .all({ findingId }) as unknown as StatusHistoryRow[];
}

export function listProjectAnalyses(projectId: number): AnalysisRow[] {
  return getDb()
    .prepare(
      `SELECT a.id, pr.number AS prNumber, a.head_sha AS headSha, a.trigger, a.outcome,
              a.summary, a.created_at AS createdAt
       FROM analyses a
       JOIN pull_requests pr ON pr.id = a.pull_request_id
       WHERE pr.project_id = @projectId
       ORDER BY a.created_at DESC, a.id DESC`,
    )
    .all({ projectId }) as unknown as AnalysisRow[];
}

export function getAnalysis(id: number): AnalysisDetail | null {
  const row = getDb()
    .prepare(
      `SELECT a.id, pr.number AS prNumber, pr.project_id AS projectId, a.head_sha AS headSha,
              a.trigger, a.outcome, a.summary, a.provider, a.model, a.comment, a.materials,
              a.raw_response AS rawResponse,
              a.created_at AS createdAt
       FROM analyses a
       JOIN pull_requests pr ON pr.id = a.pull_request_id
       WHERE a.id = @id`,
    )
    .get({ id }) as (Omit<AnalysisDetail, "materials"> & { materials: string | null }) | undefined;
  if (!row) return null;
  return { ...row, materials: parseJson<AnalysisMaterials>(row.materials) };
}

/** Finding status changes made by one analysis, new findings included. */
export function listAnalysisChanges(analysisId: number): AnalysisChange[] {
  return getDb()
    .prepare(
      `SELECT h.finding_id AS findingId, pr.number AS prNumber, f.title,
              h.old_status AS oldStatus, h.new_status AS newStatus, h.reason
       FROM finding_status_history h
       JOIN findings f ON f.id = h.finding_id
       JOIN pull_requests pr ON pr.id = f.pull_request_id
       WHERE h.analysis_id = @analysisId
       ORDER BY h.id`,
    )
    .all({ analysisId }) as unknown as AnalysisChange[];
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
 * findings → analyses → review jobs → pull requests → participants → assignments →
 * project.
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
    `DELETE FROM review_jobs WHERE pull_request_id IN
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
  info: {
    author?: string | null;
    title?: string | null;
    state?: PullRequestState | null;
    headSha?: string | null;
  } = {},
): number {
  const db = getDb();
  const row = db
    .prepare(
      `INSERT INTO pull_requests (project_id, number, author_login, title, state, head_sha)
       VALUES (@projectId, @number, @author, @title, @state, @headSha)
       ON CONFLICT (project_id, number) DO UPDATE SET
         author_login = COALESCE(@author, pull_requests.author_login),
         title = COALESCE(@title, pull_requests.title),
         state = COALESCE(@state, pull_requests.state),
         head_sha = COALESCE(@headSha, pull_requests.head_sha),
         updated_at = datetime('now')
       RETURNING id`,
    )
    .get({
      projectId,
      number,
      author: info.author ?? null,
      title: info.title ?? null,
      state: info.state ?? null,
      headSha: info.headSha ?? null,
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
  materials?: AnalysisMaterials | null;
  rawResponse?: string | null;
}): number {
  const row = getDb()
    .prepare(
      `INSERT INTO analyses
         (pull_request_id, head_sha, trigger, outcome, summary, provider, model, materials,
          raw_response)
       VALUES (@prId, @headSha, @trigger, @outcome, @summary, @provider, @model, @materials,
               @rawResponse)
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
      materials: params.materials ? JSON.stringify(params.materials) : null,
      rawResponse: params.rawResponse ?? null,
    }) as { id: number };
  return row.id;
}

/** Remember the comment actually published to the pull request for an analysis. */
export function setAnalysisComment(analysisId: number, comment: string): void {
  getDb()
    .prepare("UPDATE analyses SET comment = @comment WHERE id = @analysisId")
    .run({ analysisId, comment });
}

/**
 * Open findings of the whole project the PR belongs to: a later PR may fix a finding
 * raised in an earlier one. Findings of other PRs closed without merge are left out —
 * that code never reached the main branch. The PR's own findings are always included.
 */
export function loadOpenFindings(prId: number): PriorFinding[] {
  const rows = getDb()
    .prepare(
      `SELECT f.id, pr.number AS prNumber, f.area, f.severity, f.title, f.locations, f.verify,
              f.status
       FROM findings f
       JOIN pull_requests pr ON pr.id = f.pull_request_id
       WHERE pr.project_id = (SELECT project_id FROM pull_requests WHERE id = @prId)
         AND f.status IN ${OPEN_STATUSES}
         AND (pr.id = @prId OR COALESCE(pr.state, 'open') != 'closed')
       ORDER BY f.id`,
    )
    .all({ prId }) as unknown as Array<Omit<PriorFinding, "locations"> & { locations: string | null }>;
  return rows.map((r) => ({ ...r, locations: parseJson<FindingLocation[]>(r.locations) ?? [] }));
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

/** A prior finding the model mentioned but left with an open status. */
export interface KeptFinding {
  findingId: number;
  title: string;
  status: FindingStatus;
  reason: string | null;
}

export interface ReconcileOptions {
  /** Ids of the prior findings given to the model; any other prior_id makes a new finding. */
  allowedPriorIds: ReadonlySet<number>;
  /** False for a reconciliation after a comment: it only changes statuses. */
  allowNew: boolean;
  /** The PR is already merged: a fix is final (`closed`), not waiting for a merge. */
  fixesFinal?: boolean;
}

/**
 * Применить результат сверки модели в одной транзакции. Правила:
 * - prior_id принимается только из переданного модели набора;
 * - у прошлой находки модель меняет статус и причину; серьёзность, область и суть
 *   фиксируются при создании, остальные поля обновляются только непустыми значениями;
 * - «исправлено» по diff PR — это `pending` (ждёт слияния PR в основную ветку, см.
 *   resolvePendingOnClose), а не окончательное `closed`;
 * - находки, которых модель не упомянула, не трогаем.
 * Возвращает смены статусов и оставленные открытыми прошлые находки — по ним
 * вызывающий пишет комментарий.
 */
export function applyReconciliation(
  prId: number,
  analysisId: number,
  result: ReconcileResult,
  options: ReconcileOptions,
): { created: number; statusChanges: StatusChange[]; kept: KeptFinding[] } {
  const db = getDb();
  const statusChanges: StatusChange[] = [];
  const kept: KeptFinding[] = [];
  let created = 0;

  const insertFinding = db.prepare(
    `INSERT INTO findings
       (pull_request_id, area, severity, title, description, locations, verify, evidence,
        impact, recommendation, status, first_analysis_id, last_analysis_id)
     VALUES (@prId, @area, @severity, @title, @description, @locations, @verify, @evidence,
             @impact, @recommendation, 'open', @analysisId, @analysisId)
     RETURNING id`,
  );
  const updateFinding = db.prepare(
    `UPDATE findings SET
       description = COALESCE(@description, description),
       locations = COALESCE(@locations, locations),
       evidence = COALESCE(@evidence, evidence),
       impact = COALESCE(@impact, impact),
       recommendation = COALESCE(@recommendation, recommendation),
       status = @status,
       resolved_by_pr_id = CASE WHEN @status IN ('pending', 'closed') THEN @prId ELSE NULL END,
       last_analysis_id = @analysisId, updated_at = datetime('now')
     WHERE id = @id`,
  );
  const getPrior = db.prepare("SELECT status, title FROM findings WHERE id = @id");
  const insertHistory = db.prepare(
    `INSERT INTO finding_status_history (finding_id, old_status, new_status, reason, analysis_id)
     VALUES (@findingId, @oldStatus, @newStatus, @reason, @analysisId)`,
  );

  db.exec("BEGIN");
  try {
    for (const f of result.findings) {
      const text = {
        description: f.description ?? null,
        locations: f.locations && f.locations.length > 0 ? JSON.stringify(f.locations) : null,
        evidence: f.evidence ?? null,
        impact: f.impact ?? null,
        recommendation: f.recommendation ?? null,
      };
      const prior =
        f.priorId != null && options.allowedPriorIds.has(f.priorId)
          ? (getPrior.get({ id: f.priorId }) as { status: FindingStatus; title: string } | undefined)
          : undefined;

      if (!prior) {
        if (!options.allowNew) continue;
        const row = insertFinding.get({
          prId,
          analysisId,
          area: f.area ?? null,
          severity: f.severity ?? null,
          title: f.title,
          verify: f.verify ?? null,
          ...text,
        }) as { id: number };
        created += 1;
        insertHistory.run({
          findingId: row.id,
          oldStatus: null,
          newStatus: "open",
          reason: f.reason ?? null,
          analysisId,
        });
        statusChanges.push({
          findingId: row.id,
          title: f.title,
          oldStatus: null,
          newStatus: "open",
          reason: f.reason ?? null,
        });
        continue;
      }

      const findingId = f.priorId as number;
      const status: FindingStatus =
        f.status === "closed" ? (options.fixesFinal ? "closed" : "pending") : f.status;
      updateFinding.run({ id: findingId, prId, analysisId, status, ...text });
      if (prior.status !== status) {
        insertHistory.run({
          findingId,
          oldStatus: prior.status,
          newStatus: status,
          reason: f.reason ?? null,
          analysisId,
        });
        statusChanges.push({
          findingId,
          title: prior.title,
          oldStatus: prior.status,
          newStatus: status,
          reason: f.reason ?? null,
        });
      } else if (status === "open" || status === "reopened") {
        kept.push({ findingId, title: prior.title, status, reason: f.reason ?? null });
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { created, statusChanges, kept };
}

/**
 * Second step of closing: when the PR whose diff showed a fix is closed, its `pending`
 * findings become `closed` if it was merged into the default branch, go back to `open`
 * if it was closed without merge, and stay `pending` if it was merged elsewhere.
 */
export function resolvePendingOnClose(
  prId: number,
  outcome: "merged-default" | "merged-other" | "closed",
): void {
  if (outcome === "merged-other") return;
  const db = getDb();
  const newStatus: FindingStatus = outcome === "merged-default" ? "closed" : "open";
  const reason =
    outcome === "merged-default"
      ? "Исправление слито в основную ветку."
      : "Pull request с исправлением закрыт без слияния.";
  const ids = (
    db
      .prepare("SELECT id FROM findings WHERE status = 'pending' AND resolved_by_pr_id = @prId")
      .all({ prId }) as Array<{ id: number }>
  ).map((r) => r.id);
  if (ids.length === 0) return;

  const update = db.prepare(
    `UPDATE findings SET status = @newStatus,
       resolved_by_pr_id = CASE WHEN @newStatus = 'closed' THEN resolved_by_pr_id ELSE NULL END,
       updated_at = datetime('now')
     WHERE id = @id`,
  );
  const history = db.prepare(
    `INSERT INTO finding_status_history (finding_id, old_status, new_status, reason)
     VALUES (@id, 'pending', @newStatus, @reason)`,
  );
  db.exec("BEGIN");
  try {
    for (const id of ids) {
      update.run({ id, newStatus });
      history.run({ id, newStatus, reason });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** A person (supervisor or head) overrides the model: reopen, or dismiss as a false finding. */
export function setFindingStatusByPerson(params: {
  findingId: number;
  status: "open" | "dismissed";
  reason: string;
  actor: string;
}): void {
  const db = getDb();
  const prev = db.prepare("SELECT status FROM findings WHERE id = @id").get({
    id: params.findingId,
  }) as { status: FindingStatus } | undefined;
  if (!prev || prev.status === params.status) return;
  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE findings SET status = @status, resolved_by_pr_id = NULL,
         updated_at = datetime('now') WHERE id = @id`,
    ).run({ id: params.findingId, status: params.status });
    db.prepare(
      `INSERT INTO finding_status_history (finding_id, old_status, new_status, reason, actor)
       VALUES (@id, @oldStatus, @status, @reason, @actor)`,
    ).run({
      id: params.findingId,
      oldStatus: prev.status,
      status: params.status,
      reason: params.reason,
      actor: params.actor,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// --- Review queue ---

export type JobKind = "commit" | "comment";
export type JobStatus = "queued" | "running" | "done" | "failed" | "superseded";

export interface ReviewJob {
  id: number;
  prId: number;
  projectId: number;
  kind: JobKind;
  headSha: string | null;
  checkRunId: number | null;
  /** Everything needed to run the job without the webhook payload (JSON). */
  payload: unknown;
  status: JobStatus;
  attempts: number;
  checkConcluded: boolean;
  createdAt: string;
}

type RawJob = Omit<ReviewJob, "payload" | "checkConcluded"> & {
  payload: string;
  checkConcluded: number;
};

const JOB_SELECT = `
  SELECT j.id, j.pull_request_id AS prId, pr.project_id AS projectId, j.kind,
         j.head_sha AS headSha, j.check_run_id AS checkRunId, j.payload, j.status,
         j.attempts, j.check_concluded AS checkConcluded, j.created_at AS createdAt
  FROM review_jobs j
  JOIN pull_requests pr ON pr.id = j.pull_request_id`;

function toJob(row: RawJob): ReviewJob {
  return { ...row, payload: JSON.parse(row.payload), checkConcluded: row.checkConcluded === 1 };
}

const ACTIVE_JOB = "('queued', 'running')";

function seconds(ms: number): string {
  return `+${Math.max(0, Math.round(ms / 1000))} seconds`;
}

/**
 * Queue a commit review; synchronous, so nothing can interleave between the checks and the
 * insert. Not queued when this head is already active, or when the PR's recorded head is
 * another commit (a newer one arrived). Queued jobs of other heads of the PR are replaced:
 * only the latest commit is reviewed; their open check-runs are returned to be concluded.
 * The job's own check-run is attached afterwards (setJobCheckRun).
 */
export function enqueueCommitJob(params: {
  prId: number;
  headSha: string;
  payload: unknown;
  delayMs: number;
  deadlineMs: number;
}): { jobId: number | null; supersededCheckRunIds: number[] } {
  const db = getDb();
  if (hasJobForHead(params.prId, params.headSha, true)) {
    return { jobId: null, supersededCheckRunIds: [] };
  }
  if (getPullRequestHead(params.prId) !== params.headSha) {
    return { jobId: null, supersededCheckRunIds: [] };
  }
  db.exec("BEGIN");
  try {
    const replaced = db
      .prepare(
        `SELECT check_run_id AS checkRunId, check_concluded AS concluded FROM review_jobs
         WHERE pull_request_id = @prId AND kind = 'commit' AND status = 'queued'
           AND head_sha != @headSha`,
      )
      .all({ prId: params.prId, headSha: params.headSha }) as Array<{
      checkRunId: number | null;
      concluded: number;
    }>;
    db.prepare(
      `UPDATE review_jobs SET status = 'superseded', updated_at = datetime('now')
       WHERE pull_request_id = @prId AND kind = 'commit' AND status = 'queued'
         AND head_sha != @headSha`,
    ).run({ prId: params.prId, headSha: params.headSha });
    const row = db
      .prepare(
        `INSERT INTO review_jobs
           (pull_request_id, kind, head_sha, payload, run_after, deadline_at)
         VALUES (@prId, 'commit', @headSha, @payload,
                 datetime('now', @delay), datetime('now', @deadline))
         RETURNING id`,
      )
      .get({
        prId: params.prId,
        headSha: params.headSha,
        payload: JSON.stringify(params.payload),
        delay: seconds(params.delayMs),
        deadline: seconds(params.deadlineMs),
      }) as { id: number };
    db.exec("COMMIT");
    return {
      jobId: row.id,
      supersededCheckRunIds: replaced
        .filter((r) => r.checkRunId !== null && r.concluded === 0)
        .map((r) => r.checkRunId as number),
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Attach the required check-run created for a job; returns the job's status by then. */
export function setJobCheckRun(jobId: number, checkRunId: number): JobStatus | null {
  const db = getDb();
  db.prepare("UPDATE review_jobs SET check_run_id = @checkRunId WHERE id = @jobId").run({
    jobId,
    checkRunId,
  });
  const row = db.prepare("SELECT status FROM review_jobs WHERE id = @jobId").get({ jobId }) as
    | { status: JobStatus }
    | undefined;
  return row?.status ?? null;
}

export function getJobCheckRun(jobId: number): number | null {
  const row = getDb()
    .prepare("SELECT check_run_id AS id FROM review_jobs WHERE id = @jobId")
    .get({ jobId }) as { id: number | null } | undefined;
  return row?.id ?? null;
}

/** A PR was closed without merge: its queued commit jobs are dropped; returns open checks. */
export function supersedeCommitJobs(prId: number): number[] {
  const db = getDb();
  const ids = (
    db
      .prepare(
        `SELECT check_run_id AS id FROM review_jobs WHERE pull_request_id = @prId
           AND kind = 'commit' AND status = 'queued' AND check_concluded = 0
           AND check_run_id IS NOT NULL`,
      )
      .all({ prId }) as Array<{ id: number }>
  ).map((r) => r.id);
  db.prepare(
    `UPDATE review_jobs SET status = 'superseded', updated_at = datetime('now')
     WHERE pull_request_id = @prId AND kind = 'commit' AND status = 'queued'`,
  ).run({ prId });
  return ids;
}

/**
 * Save a student reply and queue its reconciliation in one transaction, so a reply is
 * never stored without its job. False when the comment was already saved.
 */
export function saveReplyAndEnqueue(params: {
  prId: number;
  commentId: number;
  login: string | null;
  body: string;
  payload: unknown;
}): boolean {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const isNew = saveStudentResponse(params);
    if (isNew) enqueueCommentJob({ prId: params.prId, payload: params.payload });
    db.exec("COMMIT");
    return isNew;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function enqueueCommentJob(params: { prId: number; payload: unknown }): void {
  getDb()
    .prepare(
      `INSERT INTO review_jobs (pull_request_id, kind, payload)
       VALUES (@prId, 'comment', @payload)`,
    )
    .run({ prId: params.prId, payload: JSON.stringify(params.payload) });
}

/**
 * A commit job for this PR and head exists: queued or running (`activeOnly`), or in any
 * state but replaced — then a failed head is not retried on its own.
 */
export function hasJobForHead(prId: number, headSha: string, activeOnly = false): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM review_jobs WHERE pull_request_id = @prId AND head_sha = @headSha
         AND kind = 'commit'
         AND status IN (${activeOnly ? "'queued', 'running'" : "'queued', 'running', 'done', 'failed'"})
       LIMIT 1`,
    )
    .get({ prId, headSha });
  return row !== undefined;
}

export function hasActiveCommitJob(prId: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM review_jobs WHERE pull_request_id = @prId AND kind = 'commit'
         AND status IN ${ACTIVE_JOB} LIMIT 1`,
    )
    .get({ prId });
  return row !== undefined;
}

/** Run the PR's waiting commit job now (a person asked for it); false if there is none. */
export function bringCommitJobForward(prId: number): boolean {
  const res = getDb()
    .prepare(
      `UPDATE review_jobs SET run_after = datetime('now'), updated_at = datetime('now')
       WHERE pull_request_id = @prId AND kind = 'commit' AND status = 'queued'`,
    )
    .run({ prId });
  return res.changes > 0;
}

/** After a restart nothing is running: interrupted jobs go back to the queue. */
export function requeueRunningJobs(): number {
  return Number(
    getDb()
      .prepare(
        `UPDATE review_jobs SET status = 'queued', updated_at = datetime('now')
         WHERE status = 'running'`,
      )
      .run().changes,
  );
}

/** Due jobs, oldest first: at most one per project, none for a project with a running job. */
export function listDueJobs(limit: number): ReviewJob[] {
  const rows = getDb()
    .prepare(
      `${JOB_SELECT}
       WHERE j.status = 'queued' AND j.run_after <= datetime('now')
         AND pr.project_id NOT IN (
           SELECT p2.project_id FROM review_jobs j2
           JOIN pull_requests p2 ON p2.id = j2.pull_request_id WHERE j2.status = 'running')
       ORDER BY j.run_after, j.id`,
    )
    .all() as unknown as RawJob[];
  const seen = new Set<number>();
  const due: ReviewJob[] = [];
  for (const row of rows) {
    if (seen.has(row.projectId)) continue;
    seen.add(row.projectId);
    due.push(toJob(row));
    if (due.length >= limit) break;
  }
  return due;
}

/** Commit jobs past their deadline whose required check is still open. */
export function listOverdueJobs(): ReviewJob[] {
  return (
    getDb()
      .prepare(
        `${JOB_SELECT}
         WHERE j.kind = 'commit' AND j.status = 'queued' AND j.check_concluded = 0
           AND j.check_run_id IS NOT NULL AND j.deadline_at <= datetime('now')`,
      )
      .all() as unknown as RawJob[]
  ).map(toJob);
}

/** Claim a queued job; false if it is no longer queued (replaced meanwhile). */
export function markJobRunning(id: number): boolean {
  const res = getDb()
    .prepare(
      `UPDATE review_jobs SET status = 'running', attempts = attempts + 1,
         updated_at = datetime('now') WHERE id = @id AND status = 'queued'`,
    )
    .run({ id });
  return res.changes > 0;
}

/** Finish an active job; a job already replaced or finished is left as it is. */
export function finishJob(
  id: number,
  status: "done" | "failed" | "superseded",
  error?: string,
): void {
  getDb()
    .prepare(
      `UPDATE review_jobs SET status = @status, last_error = @error, updated_at = datetime('now')
       WHERE id = @id AND status IN ${ACTIVE_JOB}`,
    )
    .run({ id, status, error: error ?? null });
}

/** Put an active job back in the queue to run after `delayMs` (or at `at`, SQLite UTC time). */
export function rescheduleJob(
  id: number,
  when: { delayMs?: number; at?: string },
  error?: string,
): void {
  getDb()
    .prepare(
      `UPDATE review_jobs SET status = 'queued',
         run_after = COALESCE(@at, datetime('now', @delay)),
         last_error = COALESCE(@error, last_error), updated_at = datetime('now')
       WHERE id = @id AND status IN ${ACTIVE_JOB}`,
    )
    .run({ id, at: when.at ?? null, delay: seconds(when.delayMs ?? 0), error: error ?? null });
}

/** Jobs marked running in the database that this process is not running (lost). */
export function requeueStrayRunningJobs(runningHere: ReadonlySet<number>): number {
  const db = getDb();
  const ids = (
    db.prepare("SELECT id FROM review_jobs WHERE status = 'running'").all() as Array<{ id: number }>
  )
    .map((r) => r.id)
    .filter((id) => !runningHere.has(id));
  for (const id of ids) {
    db.prepare(
      "UPDATE review_jobs SET status = 'queued', updated_at = datetime('now') WHERE id = @id",
    ).run({ id });
  }
  return ids.length;
}

/** The job's required check was concluded without a review ("deadline" or "limit"). */
export function markCheckConcluded(id: number, note: "deadline" | "limit"): void {
  getDb()
    .prepare(
      `UPDATE review_jobs SET check_concluded = 1, note = @note, updated_at = datetime('now')
       WHERE id = @id`,
    )
    .run({ id, note });
}

/** Model requests of a project in the last 24 hours, and when the oldest of them expires. */
export function recentAnalysesOfProject(projectId: number): {
  count: number;
  freeAt: string | null;
} {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS count, datetime(MIN(a.created_at), '+1 day') AS freeAt
       FROM analyses a JOIN pull_requests pr ON pr.id = a.pull_request_id
       WHERE pr.project_id = @projectId AND a.created_at > datetime('now', '-1 day')
         AND a.outcome != 'error'`,
    )
    .get({ projectId }) as { count: number; freeAt: string | null };
}

export function getPullRequestHead(prId: number): string | null {
  const row = getDb()
    .prepare("SELECT head_sha AS headSha FROM pull_requests WHERE id = @prId")
    .get({ prId }) as { headSha: string | null } | undefined;
  return row?.headSha ?? null;
}

export interface UnreviewedPr {
  prId: number;
  number: number;
  status: JobStatus;
  note: string | null;
}

/**
 * PRs of a project whose latest commit job has no review yet although its check was
 * already concluded ("not reviewed": deadline or daily limit), or which failed for good.
 */
export function listUnreviewedPrs(projectId: number): UnreviewedPr[] {
  return getDb()
    .prepare(
      `SELECT pr.id AS prId, pr.number, j.status, j.note
       FROM review_jobs j JOIN pull_requests pr ON pr.id = j.pull_request_id
       WHERE pr.project_id = @projectId AND j.kind = 'commit'
         AND COALESCE(pr.state, 'open') = 'open'
         AND j.id = (SELECT MAX(id) FROM review_jobs
                     WHERE pull_request_id = pr.id AND kind = 'commit' AND status != 'superseded')
         AND ((j.status IN ${ACTIVE_JOB} AND j.check_concluded = 1) OR j.status = 'failed')
       ORDER BY pr.number`,
    )
    .all({ projectId }) as unknown as UnreviewedPr[];
}

/** Number of PRs per project listed by listUnreviewedPrs, for the overview. */
export function countUnreviewedPrs(projectId: number): number {
  return listUnreviewedPrs(projectId).length;
}

export function getPullRequest(prId: number): {
  id: number;
  projectId: number;
  number: number;
  headSha: string | null;
  author: string | null;
  title: string | null;
  state: PullRequestState | null;
} | null {
  const row = getDb()
    .prepare(
      `SELECT id, project_id AS projectId, number, head_sha AS headSha, author_login AS author,
              title, state FROM pull_requests WHERE id = @prId`,
    )
    .get({ prId }) as ReturnType<typeof getPullRequest> | undefined;
  return row ?? null;
}
