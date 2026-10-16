import { getDb } from "@/lib/db";
import type { FindingArea, FindingLocation, Severity } from "@/lib/curator/finding";
import { findingScope, fixVisible, type ChangedLines, type FindingScope } from "@/lib/curator/scope";

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
  /** Findings dismissed by an explanation, given so they are not raised again. */
  dismissedFindings?: number;
  /** Notes about the project were given. */
  notes?: boolean;
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

/** A finding dismissed by an explanation (or by a person), with the reason recorded. */
export interface DismissedFinding extends PriorFinding {
  reason: string | null;
  /** Dismissed by a supervisor or the head: the model may not reopen it. */
  byPerson: boolean;
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
  /** New full text of the notes about the project; null — leave them as they are. */
  notes?: string | null;
}

/** active — в работе; paused — разбор отключён, проект остаётся в памяти. */
export type ProjectStatus = "active" | "paused";

export type PullRequestState = "open" | "merged" | "closed";

/** `stale`: the model answered, but the PR had moved on (new commit, closed) — not applied. */
export type AnalysisOutcome = "ok" | "parse_error" | "error" | "stale";

/** `agent_fallback`: the agent failed and the same job reviewed the diff. */
export type AnalysisMode = "diff" | "agent" | "agent_fallback";

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
  oldestOpenAt: string | null;
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
  /** `branch`: the problem exists only in the changes of its unmerged PR. */
  scope: FindingScope;
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
  mode: AnalysisMode | null;
  /** Tokens of all model requests of the analysis (agent, review, verification). */
  tokensIn: number | null;
  tokensOut: number | null;
  /** Repository files the agent read. */
  viewedFiles: string[] | null;
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

/** An open finding (`f`) that a review of PR `@prId` may reconcile. */
const RECONCILABLE = `f.status IN ${OPEN_STATUSES}
  AND (f.pull_request_id = @prId OR f.scope = 'project')
  AND NOT (f.status = 'pending' AND f.resolved_by_pr_id IS NOT @prId)`;

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

    // Branch findings of PRs closed without merge never reached the main branch, so they
    // are not "open" for the project (see принятые решения.md).
    const counts = db
      .prepare(
        `SELECT
           COUNT(*) AS openFindings,
           SUM(CASE WHEN f.severity = 'critical' THEN 1 ELSE 0 END) AS serious,
           MIN(CASE WHEN f.severity = 'critical' THEN f.created_at END) AS oldestSerious,
           MIN(f.created_at) AS oldestOpen
         FROM findings f
         JOIN pull_requests pr ON pr.id = f.pull_request_id
         WHERE pr.project_id = @id
           AND f.status IN ${OPEN_STATUSES}
           AND (f.scope = 'project' OR COALESCE(pr.state, 'open') != 'closed')`,
      )
      .get({ id: p.id }) as {
      openFindings: number;
      serious: number | null;
      oldestSerious: string | null;
      oldestOpen: string | null;
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
      oldestOpenAt: counts.oldestOpen,
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
         SELECT MAX(updated_at) AS ts FROM pull_requests WHERE project_id = @projectId AND number != 0
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
         f.evidence, f.impact, f.recommendation, f.status, f.scope,
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
              a.raw_response AS rawResponse, a.mode, a.tokens_in AS tokensIn,
              a.tokens_out AS tokensOut, a.viewed_files AS viewedFiles,
              a.created_at AS createdAt
       FROM analyses a
       JOIN pull_requests pr ON pr.id = a.pull_request_id
       WHERE a.id = @id`,
    )
    .get({ id }) as
    | (Omit<AnalysisDetail, "materials" | "viewedFiles"> & {
        materials: string | null;
        viewedFiles: string | null;
      })
    | undefined;
  if (!row) return null;
  return {
    ...row,
    materials: parseJson<AnalysisMaterials>(row.materials),
    viewedFiles: parseJson<string[]>(row.viewedFiles),
  };
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

/** Connect a repository; a supervisor who connects it is assigned to it in the same step. */
export function createProjectManual(
  owner: string,
  repo: string,
  name?: string,
  supervisorId?: string,
): number {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const id = upsertProject(owner, repo, name);
    if (supervisorId) assignSupervisor(id, supervisorId);
    db.exec("COMMIT");
    return id;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
    .prepare("SELECT 1 FROM pull_requests WHERE project_id = @id AND number != 0 LIMIT 1")
    .get({ id });
  return row !== undefined;
}

/**
 * Delete a project with everything the memory holds about it, in one transaction.
 * Order follows the foreign keys (PRAGMA foreign_keys = ON): history → responses → notes →
 * findings → analyses → review jobs → pull requests → participants → assignments →
 * project.
 * github_events are not tied to a project and stay.
 */
/**
 * Delete a project with everything about it. Its spend stays in the balance as "spent"
 * entries unless `keepSpend` is false (demo data).
 */
export function deleteProjectCascade(id: number, keepSpend = true): void {
  const db = getDb();
  const steps = [
    ...(keepSpend
      ? [
          `INSERT INTO balance_entries (provider, kind, amount_rub, at)
           SELECT a.provider, 'spent', a.cost_rub, a.created_at
           FROM analyses a JOIN pull_requests pr ON pr.id = a.pull_request_id
           WHERE pr.project_id = @id AND a.provider IS NOT NULL AND a.cost_rub > 0`,
        ]
      : []),
    `DELETE FROM finding_status_history WHERE finding_id IN
       (SELECT f.id FROM findings f JOIN pull_requests pr ON pr.id = f.pull_request_id
        WHERE pr.project_id = @id)`,
    `DELETE FROM student_responses WHERE pull_request_id IN
       (SELECT id FROM pull_requests WHERE project_id = @id)`,
    `DELETE FROM project_notes WHERE project_id = @id`,
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

/** All projects, or only a supervisor's. */
export function listAllProjects(supervisorId?: string): ProjectDetail[] {
  const s = scope(supervisorId);
  return getDb()
    .prepare(
      `SELECT id, owner, repo, name, status FROM projects
       WHERE id IN (${s.projectIds}) ORDER BY name, repo`,
    )
    .all(s.params) as unknown as ProjectDetail[];
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
    baseRef?: string | null;
    headRef?: string | null;
    mergedIntoDefault?: boolean | null;
  } = {},
): number {
  const db = getDb();
  const row = db
    .prepare(
      `INSERT INTO pull_requests
         (project_id, number, author_login, title, state, head_sha, base_ref, head_ref,
          merged_into_default)
       VALUES (@projectId, @number, @author, @title, @state, @headSha, @baseRef, @headRef,
               COALESCE(@merged, 0))
       ON CONFLICT (project_id, number) DO UPDATE SET
         author_login = COALESCE(@author, pull_requests.author_login),
         title = COALESCE(@title, pull_requests.title),
         state = COALESCE(@state, pull_requests.state),
         head_sha = COALESCE(@headSha, pull_requests.head_sha),
         base_ref = COALESCE(@baseRef, pull_requests.base_ref),
         head_ref = COALESCE(@headRef, pull_requests.head_ref),
         merged_into_default = COALESCE(@merged, pull_requests.merged_into_default),
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
      baseRef: info.baseRef ?? null,
      headRef: info.headRef ?? null,
      merged: info.mergedIntoDefault == null ? null : Number(info.mergedIntoDefault),
    }) as { id: number };
  return row.id;
}

/** Numbers of the project's PRs that are open in memory (to catch missed close events). */
export function listOpenPullRequestNumbers(projectId: number): number[] {
  return (
    getDb()
      .prepare(
        `SELECT number FROM pull_requests
         WHERE project_id = @projectId AND COALESCE(state, 'open') = 'open'`,
      )
      .all({ projectId }) as Array<{ number: number }>
  ).map((r) => r.number);
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
  trigger: "commit" | "comment" | "overview";
  outcome: AnalysisOutcome;
  summary?: string | null;
  provider?: string | null;
  model?: string | null;
  materials?: AnalysisMaterials | null;
  rawResponse?: string | null;
  mode?: AnalysisMode | null;
  tokensIn?: number;
  tokensOut?: number;
  /** Rubles spent; null when some tokens had no price. */
  costRub?: number | null;
  viewedFiles?: string[] | null;
  /** Notes about the project the review proposes, and the notes version it was given. */
  notesProposal?: string | null;
  notesBase?: number | null;
}): number {
  const row = getDb()
    .prepare(
      `INSERT INTO analyses
         (pull_request_id, head_sha, trigger, outcome, summary, provider, model, materials,
          raw_response, mode, tokens_in, tokens_out, cost_rub, viewed_files, notes_proposal,
          notes_base)
       VALUES (@prId, @headSha, @trigger, @outcome, @summary, @provider, @model, @materials,
               @rawResponse, @mode, @tokensIn, @tokensOut, @costRub, @viewedFiles, @notesProposal,
               @notesBase)
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
      mode: params.mode ?? null,
      tokensIn: params.tokensIn ?? 0,
      tokensOut: params.tokensOut ?? 0,
      costRub: params.costRub === undefined ? 0 : params.costRub,
      viewedFiles: params.viewedFiles ? JSON.stringify(params.viewedFiles) : null,
      notesProposal: params.notesProposal ?? null,
      notesBase: params.notesBase ?? null,
    }) as { id: number };
  return row.id;
}

/**
 * Tokens spent in the last 24 hours, by one project or by all (null). Every outcome
 * counts: the money is spent anyway.
 */
export function recentTokens(projectId: number | null): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(a.tokens_in, 0) + COALESCE(a.tokens_out, 0)), 0) AS tokens
       FROM analyses a JOIN pull_requests pr ON pr.id = a.pull_request_id
       WHERE a.created_at > datetime('now', '-1 day')
         AND (@projectId IS NULL OR pr.project_id = @projectId)`,
    )
    .get({ projectId }) as { tokens: number };
  return row.tokens;
}

// --- Usage and balance ---

/** Spend of one local day; `unpriced` — tokens of analyses without a price. */
export interface DaySpend {
  day: string;
  rub: number;
  tokens: number;
  analyses: number;
  unpriced: number;
}

/** Spend per local day over the last `days` days (oldest first, days without spend left out). */
export function spendByDay(days: number, supervisorId?: string): DaySpend[] {
  const s = scope(supervisorId);
  return getDb()
    .prepare(
      `SELECT date(a.created_at, 'localtime') AS day,
              COALESCE(SUM(a.cost_rub), 0) AS rub,
              COALESCE(SUM(COALESCE(a.tokens_in, 0) + COALESCE(a.tokens_out, 0)), 0) AS tokens,
              COUNT(*) AS analyses,
              COALESCE(SUM(CASE WHEN a.cost_rub IS NULL
                THEN COALESCE(a.tokens_in, 0) + COALESCE(a.tokens_out, 0) ELSE 0 END), 0) AS unpriced
       FROM analyses a JOIN pull_requests pr ON pr.id = a.pull_request_id
       WHERE pr.project_id IN (${s.projectIds})
         AND date(a.created_at, 'localtime') > date('now', 'localtime', @since)
       GROUP BY day ORDER BY day`,
    )
    .all({ ...s.params, since: `-${days} days` }) as unknown as DaySpend[];
}

export interface ProjectSpend {
  id: number;
  owner: string;
  repo: string;
  name: string | null;
  /** Analyses that produced a review. */
  reviews: number;
  /** Analyses that failed (error, unreadable answer). */
  failures: number;
  /** Commits whose check was concluded without a review: daily limit or token budget. */
  notReviewed: number;
  tokens: number;
  rub: number;
  /** Tokens of analyses without a price. */
  unpriced: number;
  /** Tokens in the last 24 hours, compared with the project's daily budget. */
  dayTokens: number;
}

/** Per-project spend and activity over the last `days` days. */
export function spendByProject(days: number, supervisorId?: string): ProjectSpend[] {
  const s = scope(supervisorId);
  return getDb()
    .prepare(
      `SELECT p.id, p.owner, p.repo, p.name,
              COALESCE(a.reviews, 0) AS reviews, COALESCE(a.failures, 0) AS failures,
              COALESCE(j.notReviewed, 0) AS notReviewed,
              COALESCE(a.tokens, 0) AS tokens, COALESCE(a.rub, 0) AS rub,
              COALESCE(a.unpriced, 0) AS unpriced, COALESCE(a.dayTokens, 0) AS dayTokens
       FROM projects p
       LEFT JOIN (
         SELECT pr.project_id,
                SUM(CASE WHEN a.outcome = 'ok' THEN 1 ELSE 0 END) AS reviews,
                SUM(CASE WHEN a.outcome IN ('error', 'parse_error') THEN 1 ELSE 0 END) AS failures,
                SUM(COALESCE(a.tokens_in, 0) + COALESCE(a.tokens_out, 0)) AS tokens,
                SUM(a.cost_rub) AS rub,
                SUM(CASE WHEN a.cost_rub IS NULL
                  THEN COALESCE(a.tokens_in, 0) + COALESCE(a.tokens_out, 0) ELSE 0 END) AS unpriced,
                SUM(CASE WHEN a.created_at > datetime('now', '-1 day')
                  THEN COALESCE(a.tokens_in, 0) + COALESCE(a.tokens_out, 0) ELSE 0 END) AS dayTokens
         FROM analyses a JOIN pull_requests pr ON pr.id = a.pull_request_id
         WHERE date(a.created_at, 'localtime') > date('now', 'localtime', @since)
         GROUP BY pr.project_id
       ) a ON a.project_id = p.id
       LEFT JOIN (
         SELECT pr.project_id, COUNT(*) AS notReviewed
         FROM review_jobs j JOIN pull_requests pr ON pr.id = j.pull_request_id
         WHERE j.note IN ('limit', 'budget')
           AND date(j.created_at, 'localtime') > date('now', 'localtime', @since)
         GROUP BY pr.project_id
       ) j ON j.project_id = p.id
       WHERE p.id IN (${s.projectIds})
       ORDER BY rub DESC, tokens DESC, p.name, p.repo`,
    )
    .all({ ...s.params, since: `-${days} days` }) as unknown as ProjectSpend[];
}

export type BalanceKind = "topup" | "balance";

/**
 * A top-up of a provider's account, or its balance read from the provider's dashboard.
 * Spend of deleted projects is kept as "spent" entries, not listed.
 */
export interface BalanceEntry {
  id: number;
  provider: string;
  kind: BalanceKind;
  amountRub: number;
  at: string;
  actor: string | null;
}

export function listBalanceEntries(): BalanceEntry[] {
  return getDb()
    .prepare(
      `SELECT id, provider, kind, amount_rub AS amountRub, at, actor
       FROM balance_entries WHERE kind IN ('topup', 'balance') ORDER BY at DESC, id DESC`,
    )
    .all() as unknown as BalanceEntry[];
}

/** Recorded at the current moment: the balance changes from then on. */
export function addBalanceEntry(entry: Omit<BalanceEntry, "id" | "at">): void {
  getDb()
    .prepare(
      `INSERT INTO balance_entries (provider, kind, amount_rub, at, actor)
       VALUES (@provider, @kind, @amountRub, datetime('now'), @actor)`,
    )
    .run({ ...entry });
}

export function deleteBalanceEntry(id: number): void {
  getDb()
    .prepare("DELETE FROM balance_entries WHERE id = @id AND kind IN ('topup', 'balance')")
    .run({ id });
}

export interface ProviderBalance {
  provider: string;
  /** Approximate rubles left: the last balance read, plus later top-ups, minus later spend. */
  rub: number;
  /** Average spend per day over the last 7 days (or the shorter history); 0 when nothing was spent. */
  dailyRub: number;
  /** Tokens counted against the balance that had no price, so the balance is overstated. */
  unpriced: number;
}

/**
 * Approximate balance per provider with entries. The start is the latest balance read (or the
 * first top-up when there is none); spend is what analyses of the provider cost since then.
 * Entry times are UTC like the rest of the database.
 */
export function providerBalances(): ProviderBalance[] {
  const db = getDb();
  const providers = db
    .prepare(
      "SELECT DISTINCT provider FROM balance_entries WHERE kind IN ('topup', 'balance') ORDER BY provider",
    )
    .all() as Array<{ provider: string }>;
  return providers.map(({ provider }) => {
    const base = db
      .prepare(
        `SELECT amount_rub AS amount, at FROM balance_entries
         WHERE provider = @provider AND kind = 'balance' ORDER BY at DESC, id DESC LIMIT 1`,
      )
      .get({ provider }) as { amount: number; at: string } | undefined;
    const since =
      base?.at ??
      (db
        .prepare(
          "SELECT MIN(at) AS at FROM balance_entries WHERE provider = @provider AND kind IN ('topup', 'balance')",
        )
        .get({ provider }) as { at: string }).at;
    const topups = db
      .prepare(
        `SELECT COALESCE(SUM(amount_rub), 0) AS sum FROM balance_entries
         WHERE provider = @provider AND kind = 'topup' AND at ${base ? ">" : ">="} @since`,
      )
      .get({ provider, since }) as { sum: number };
    const spent = db
      .prepare(
        `SELECT COALESCE(SUM(cost_rub), 0) AS rub,
                COALESCE(SUM(CASE WHEN cost_rub IS NULL
                  THEN COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) ELSE 0 END), 0) AS unpriced
         FROM analyses WHERE provider = @provider AND created_at > @since`,
      )
      .get({ provider, since }) as { rub: number; unpriced: number };
    const deleted = db
      .prepare(
        `SELECT COALESCE(SUM(amount_rub), 0) AS rub FROM balance_entries
         WHERE provider = @provider AND kind = 'spent' AND at > @since`,
      )
      .get({ provider, since }) as { rub: number };
    const week = db
      .prepare(
        `SELECT COALESCE(SUM(cost_rub), 0) AS rub,
                julianday('now') - julianday(MIN(created_at)) AS days
         FROM analyses WHERE provider = @provider AND created_at > datetime('now', '-7 days')`,
      )
      .get({ provider }) as { rub: number; days: number | null };
    const history = db
      .prepare("SELECT julianday('now') - julianday(MIN(created_at)) AS days FROM analyses WHERE provider = @provider")
      .get({ provider }) as { days: number | null };
    const span = Math.min(7, Math.max(1, history.days ?? 7));
    return {
      provider,
      rub: (base?.amount ?? 0) + topups.sum - spent.rub - deleted.rub,
      dailyRub: week.rub / span,
      unpriced: spent.unpriced,
    };
  });
}

/** Remember the comment actually published to the pull request for an analysis. */
export function setAnalysisComment(analysisId: number, comment: string): void {
  getDb()
    .prepare("UPDATE analyses SET comment = @comment WHERE id = @analysisId")
    .run({ analysisId, comment });
}

/**
 * Open findings a review of the PR may reconcile: its own findings and the project's
 * (a later PR may fix a problem of the main branch). Branch findings of other PRs are left
 * out — that code is not in this PR — and so are findings another PR already fixed
 * (pending its merge): only that PR may change them. applyReconciliation checks the same
 * rule again.
 */
export function loadOpenFindings(prId: number): PriorFinding[] {
  const rows = getDb()
    .prepare(
      `SELECT f.id, pr.number AS prNumber, f.area, f.severity, f.title, f.locations, f.verify,
              f.status
       FROM findings f
       JOIN pull_requests pr ON pr.id = f.pull_request_id
       WHERE pr.project_id = (SELECT project_id FROM pull_requests WHERE id = @prId)
         AND ${RECONCILABLE}
       ORDER BY f.id`,
    )
    .all({ prId }) as unknown as Array<Omit<PriorFinding, "locations"> & { locations: string | null }>;
  return rows.map((r) => ({ ...r, locations: parseJson<FindingLocation[]>(r.locations) ?? [] }));
}

/**
 * Dismissed findings a review of the PR should know about (its own and the project's): the
 * model is told not to raise them again. Ones dismissed by a person come with `byPerson`.
 */
export function loadDismissedFindings(prId: number): DismissedFinding[] {
  const rows = getDb()
    .prepare(
      `SELECT f.id, pr.number AS prNumber, f.area, f.severity, f.title, f.locations, f.verify,
              f.status, h.reason, h.actor
       FROM findings f
       JOIN pull_requests pr ON pr.id = f.pull_request_id
       LEFT JOIN finding_status_history h ON h.id = (
         SELECT MAX(id) FROM finding_status_history WHERE finding_id = f.id)
       WHERE pr.project_id = (SELECT project_id FROM pull_requests WHERE id = @prId)
         AND f.status = 'dismissed'
         AND (f.pull_request_id = @prId OR f.scope = 'project')
       ORDER BY f.id DESC`,
    )
    .all({ prId }) as unknown as Array<
    Omit<DismissedFinding, "locations" | "byPerson"> & { locations: string | null; actor: string | null }
  >;
  return rows.map(({ actor, ...r }) => ({
    ...r,
    locations: parseJson<FindingLocation[]>(r.locations) ?? [],
    byPerson: actor !== null,
  }));
}

// --- Notes about the project ---

/** Longest notes kept; the model is asked for less. */
export const NOTES_MAX_CHARS = 6_000;

export interface ProjectNotes {
  id: number;
  body: string;
  /** Who wrote this version: a person's login, or null for the curator. */
  actor: string | null;
  analysisId: number | null;
  /** PR whose review wrote it (0 — a project overview); null when a person did. */
  prNumber: number | null;
  createdAt: string;
}

/** The current version of the notes about the project, if any. */
export function getProjectNotes(projectId: number): ProjectNotes | null {
  const row = getDb()
    .prepare(
      `SELECT n.id, n.body, n.actor, n.analysis_id AS analysisId, pr.number AS prNumber,
              n.created_at AS createdAt
       FROM project_notes n
       LEFT JOIN analyses a ON a.id = n.analysis_id
       LEFT JOIN pull_requests pr ON pr.id = a.pull_request_id
       WHERE n.project_id = @projectId ORDER BY n.id DESC LIMIT 1`,
    )
    .get({ projectId }) as ProjectNotes | undefined;
  return row ?? null;
}

/** Save a new version of the notes; an empty text clears them. */
export function addProjectNotes(
  projectId: number,
  body: string,
  source: { analysisId?: number | null; actor?: string | null },
): void {
  getDb()
    .prepare(
      `INSERT INTO project_notes (project_id, body, analysis_id, actor)
       VALUES (@projectId, @body, @analysisId, @actor)`,
    )
    .run({
      projectId,
      body: body.trim().slice(0, NOTES_MAX_CHARS),
      analysisId: source.analysisId ?? null,
      actor: source.actor ?? null,
    });
}

/**
 * The PR reached the main branch: the notes its review proposed become current, if the
 * review was of the merged head and the notes have not changed since it read them.
 */
export function applyNotesProposal(prId: number): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT a.id, a.notes_proposal AS proposal, a.notes_base AS base, pr.project_id AS projectId
       FROM analyses a JOIN pull_requests pr ON pr.id = a.pull_request_id
       WHERE a.pull_request_id = @prId AND a.trigger = 'commit' AND a.outcome = 'ok'
         AND a.head_sha = pr.head_sha
       ORDER BY a.id DESC LIMIT 1`,
    )
    .get({ prId }) as { id: number; proposal: string | null; base: number | null; projectId: number } | undefined;
  if (!row?.proposal) return false;
  if ((getProjectNotes(row.projectId)?.id ?? null) !== row.base) return false;
  db.exec("BEGIN");
  try {
    addProjectNotes(row.projectId, row.proposal, { analysisId: row.id });
    // Applied once: a repeated close event of the same PR does not apply it again.
    db.prepare("UPDATE analyses SET notes_proposal = NULL WHERE id = @id").run({ id: row.id });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

// --- Project overview and memory cursor ---

/**
 * A project overview is stored as the reviews of a service pull request numbered 0 (GitHub
 * numbers start at 1): its findings, analyses and jobs then count for the project like any
 * other. It is always "merged into the main branch", so it is never synced or reviewed as a PR.
 */
export const OVERVIEW_PR_NUMBER = 0;

export function ensureOverviewPullRequest(projectId: number): number {
  return upsertPullRequest(projectId, OVERVIEW_PR_NUMBER, {
    title: "Обзор проекта",
    state: "merged",
    mergedIntoDefault: true,
  });
}

/** Automatic overviews of a project (initial, memory gap) run at most this often. */
const AUTO_OVERVIEW_DAYS = 7;

/**
 * Queue an overview of the project. Not queued when one is already queued or running, or —
 * unless `force` (a person asked, the project was resumed) — when one was queued in the last
 * AUTO_OVERVIEW_DAYS days.
 */
export function enqueueOverviewJob(
  projectId: number,
  payload: unknown,
  force: boolean,
): "queued" | "active" | "recent" {
  const db = getDb();
  const latest = db
    .prepare(
      `SELECT j.status, j.created_at > datetime('now', @window) AS recent
       FROM review_jobs j JOIN pull_requests pr ON pr.id = j.pull_request_id
       WHERE pr.project_id = @projectId AND j.kind = 'overview' AND j.status != 'superseded'
       ORDER BY j.id DESC LIMIT 1`,
    )
    .get({ projectId, window: `-${AUTO_OVERVIEW_DAYS} days` }) as { status: JobStatus; recent: number } | undefined;
  if (latest && (latest.status === "queued" || latest.status === "running")) return "active";
  if (!force && latest?.recent) return "recent";
  db.prepare(
    `INSERT INTO review_jobs (pull_request_id, kind, payload) VALUES (@prId, 'overview', @payload)`,
  ).run({ prId: ensureOverviewPullRequest(projectId), payload: JSON.stringify(payload) });
  return "queued";
}

/** Latest overview job of the project: its state and when it was queued. */
export function getLatestOverviewJob(
  projectId: number,
): { status: JobStatus; createdAt: string; lastError: string | null } | null {
  const row = getDb()
    .prepare(
      `SELECT j.status, j.created_at AS createdAt, j.last_error AS lastError
       FROM review_jobs j JOIN pull_requests pr ON pr.id = j.pull_request_id
       WHERE pr.project_id = @projectId AND j.kind = 'overview' AND j.status != 'superseded'
       ORDER BY j.id DESC LIMIT 1`,
    )
    .get({ projectId }) as { status: JobStatus; createdAt: string; lastError: string | null } | undefined;
  return row ?? null;
}

/** Commit of the main branch the project memory covers; null — no overview has been made. */
export function getMemorySha(projectId: number): string | null {
  const row = getDb()
    .prepare("SELECT memory_sha AS sha FROM projects WHERE id = @projectId")
    .get({ projectId }) as { sha: string | null } | undefined;
  return row?.sha ?? null;
}

/**
 * Move the memory to `sha`, only if it still covers `expected` (it may have moved while the
 * caller was asking GitHub); false when it had moved.
 */
export function setMemorySha(projectId: number, sha: string, expected: string | null): boolean {
  const res = getDb()
    .prepare("UPDATE projects SET memory_sha = @sha WHERE id = @projectId AND memory_sha IS @expected")
    .run({ projectId, sha, expected });
  return res.changes > 0;
}

export function getOverviewIssue(projectId: number): number | null {
  const row = getDb()
    .prepare("SELECT overview_issue AS issue FROM projects WHERE id = @projectId")
    .get({ projectId }) as { issue: number | null } | undefined;
  return row?.issue ?? null;
}

export function setOverviewIssue(projectId: number, issue: number): void {
  getDb()
    .prepare("UPDATE projects SET overview_issue = @issue WHERE id = @projectId")
    .run({ projectId, issue });
}

/** Open findings of the main branch, as the overview issue lists them. */
export function listOpenProjectFindings(projectId: number): FindingRow[] {
  const rows = getDb()
    .prepare(
      `${FINDING_SELECT} WHERE pr.project_id = @projectId AND f.scope = 'project'
         AND f.status IN ${OPEN_STATUSES} ORDER BY f.id`,
    )
    .all({ projectId }) as unknown as RawFinding<FindingRow>[];
  return rows.map(toFinding);
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
  /** The model called it fixed, but the fix was not counted (`reason` says why). */
  fixNotCounted?: boolean;
}

export interface ReconcileOptions {
  /** Ids of the prior findings given to the model; any other prior_id makes a new finding. */
  allowedPriorIds: ReadonlySet<number>;
  /** False for a reconciliation after a comment: it only changes statuses. */
  allowNew: boolean;
  /**
   * The PR is already merged into the main branch: a fix is final (`closed`), not waiting
   * for a merge, and new findings belong to the project.
   */
  fixesFinal?: boolean;
  /** Changed files of the PR with their added lines. */
  changed: ChangedLines;
  /** Head branch of the PR, kept with new findings for display. */
  branch?: string | null;
  /**
   * Dismissed findings given to the model: it may only reopen them, and not those a person
   * dismissed; any other answer about them is ignored.
   */
  reopenableIds?: ReadonlySet<number>;
  /**
   * A review of the whole main branch (project overview): a fix need not show in changes,
   * and nothing is dismissed — there is no explanation to accept.
   */
  wholeRepository?: boolean;
}

/**
 * Применить результат сверки модели в одной транзакции. Правила:
 * - prior_id принимается только из переданного модели набора и только если этот PR
 *   всё ещё вправе менять находку (своя или находка проекта, не чужой `pending`);
 * - новая находка получает вид (`branch` / `project`) по местам относительно изменений PR;
 * - «исправлено» принимается, только если PR меняет один из файлов находки;
 * - у прошлой находки модель меняет статус и причину; серьёзность, область и суть
 *   фиксируются при создании, остальные поля обновляются только непустыми значениями;
 * - «исправлено» по diff PR — это `pending` (ждёт слияния PR в основную ветку, см.
 *   recordPullRequestClosed), а не окончательное `closed`;
 * - находку, снятую по объяснению, модель может только открыть снова (`reopened`), и только
 *   если её снял не человек;
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

  const changedFiles = new Set(options.changed.keys());
  const insertFinding = db.prepare(
    `INSERT INTO findings
       (pull_request_id, area, severity, title, description, locations, verify, evidence,
        impact, recommendation, status, scope, branch, first_analysis_id, last_analysis_id)
     VALUES (@prId, @area, @severity, @title, @description, @locations, @verify, @evidence,
             @impact, @recommendation, 'open', @scope, @branch, @analysisId, @analysisId)
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
  const getPrior = db.prepare(
    `SELECT f.status, f.title, f.locations FROM findings f WHERE f.id = @id AND ${RECONCILABLE}`,
  );
  const getDismissed = db.prepare(
    `SELECT f.title,
            (SELECT h.actor FROM finding_status_history h WHERE h.finding_id = f.id
               ORDER BY h.id DESC LIMIT 1) AS actor
     FROM findings f WHERE f.id = @id AND f.status = 'dismissed'
       AND (f.pull_request_id = @prId OR f.scope = 'project')`,
  );
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
      if (f.priorId != null && options.reopenableIds?.has(f.priorId)) {
        const dismissed = getDismissed.get({ id: f.priorId, prId }) as { title: string; actor: string | null } | undefined;
        if (dismissed && dismissed.actor === null && f.status === "reopened") {
          const change = { findingId: f.priorId, oldStatus: "dismissed" as const, newStatus: "reopened" as const, reason: f.reason ?? null };
          updateFinding.run({ id: f.priorId, prId, analysisId, status: "reopened", ...text });
          insertHistory.run({ ...change, analysisId });
          statusChanges.push({ ...change, title: dismissed.title });
        }
        continue;
      }
      if (options.wholeRepository && f.status === "dismissed") continue;
      const prior =
        f.priorId != null && options.allowedPriorIds.has(f.priorId)
          ? (getPrior.get({ id: f.priorId, prId }) as
              | { status: FindingStatus; title: string; locations: string | null }
              | undefined)
          : undefined;

      // Given to the model, but no longer this PR's to change (closed, dismissed, fixed by
      // another PR meanwhile): left as it is, not raised again as a new finding.
      if (!prior && f.priorId != null && options.allowedPriorIds.has(f.priorId)) continue;
      if (!prior) {
        if (!options.allowNew) continue;
        const row = insertFinding.get({
          prId,
          analysisId,
          area: f.area ?? null,
          severity: f.severity ?? null,
          title: f.title,
          verify: f.verify ?? null,
          scope: findingScope(f.locations ?? [], options.changed, options.fixesFinal ?? false),
          branch: options.branch ?? null,
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
      const priorLocations = parseJson<FindingLocation[]>(prior.locations) ?? [];
      if (f.status === "closed" && !options.wholeRepository && !fixVisible(priorLocations, changedFiles)) {
        kept.push({
          findingId,
          title: prior.title,
          status: prior.status,
          reason: "исправление не видно в изменениях этого pull request",
          fixNotCounted: true,
        });
        continue;
      }
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

export type CloseOutcome = "merged-default" | "merged-other" | "closed";

/**
 * A PR was closed. Merged into the main branch: its `pending` fixes become `closed` and its
 * findings belong to the project from now on. Closed without merge: its `pending` fixes go
 * back to `open`. Merged into another branch: its findings and fixes pass to the open PR of
 * that branch (see adoptMergedBranchFindings); they wait for one if there is none yet.
 */
export function recordPullRequestClosed(prId: number, outcome: CloseOutcome): void {
  const db = getDb();
  if (outcome === "merged-other") {
    const pr = db
      .prepare("SELECT project_id AS projectId, base_ref AS baseRef FROM pull_requests WHERE id = @prId")
      .get({ prId }) as { projectId: number; baseRef: string | null } | undefined;
    const successor = pr?.baseRef
      ? (db
          .prepare(
            `SELECT id FROM pull_requests WHERE project_id = @projectId AND head_ref = @baseRef
               AND COALESCE(state, 'open') = 'open' ORDER BY number DESC LIMIT 1`,
          )
          .get({ projectId: pr.projectId, baseRef: pr.baseRef }) as { id: number } | undefined)
      : undefined;
    if (successor) adoptMergedBranchFindings(successor.id);
    return;
  }
  // PRs merged into this one's branch may have left findings it never took over (no review
  // since): they reach the main branch with it.
  if (outcome === "merged-default") adoptMergedBranchFindings(prId);
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
    if (outcome === "merged-default") {
      db.prepare(
        "UPDATE findings SET scope = 'project' WHERE pull_request_id = @prId AND scope = 'branch'",
      ).run({ prId });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * The PR's branch received merges of other PRs (PR into PR): their open branch findings and
 * their pending fixes become this PR's, since that code now lives in this branch. Returns
 * the number of findings taken over.
 */
export function adoptMergedBranchFindings(prId: number): number {
  const db = getDb();
  const pr = db
    .prepare("SELECT project_id AS projectId, number, head_ref AS headRef FROM pull_requests WHERE id = @prId")
    .get({ prId }) as { projectId: number; number: number; headRef: string | null } | undefined;
  if (!pr?.headRef) return 0;
  const sources = (
    db
      .prepare(
        `SELECT id FROM pull_requests WHERE project_id = @projectId AND id != @prId
           AND state = 'merged' AND merged_into_default = 0 AND base_ref = @headRef`,
      )
      .all({ projectId: pr.projectId, prId, headRef: pr.headRef }) as Array<{ id: number }>
  ).map((r) => r.id);
  if (sources.length === 0) return 0;

  const reason = `Передано в PR #${pr.number}: pull request слит в его ветку.`;
  const history = db.prepare(
    `INSERT INTO finding_status_history (finding_id, old_status, new_status, reason)
     VALUES (@id, @status, @status, @reason)`,
  );
  let moved = 0;
  db.exec("BEGIN");
  try {
    for (const source of sources) {
      const owned = db
        .prepare(
          `SELECT id, status FROM findings WHERE pull_request_id = @source AND scope = 'branch'
             AND status IN ${OPEN_STATUSES}`,
        )
        .all({ source }) as Array<{ id: number; status: FindingStatus }>;
      const fixed = db
        .prepare(
          `SELECT id, status FROM findings WHERE resolved_by_pr_id = @source AND status = 'pending'`,
        )
        .all({ source }) as Array<{ id: number; status: FindingStatus }>;
      db.prepare(
        `UPDATE findings SET pull_request_id = @prId, branch = @branch, updated_at = datetime('now')
         WHERE pull_request_id = @source AND scope = 'branch' AND status IN ${OPEN_STATUSES}`,
      ).run({ prId, source, branch: pr.headRef });
      db.prepare(
        `UPDATE findings SET resolved_by_pr_id = @prId, updated_at = datetime('now')
         WHERE resolved_by_pr_id = @source AND status = 'pending'`,
      ).run({ prId, source });
      const ids = new Map([...owned, ...fixed].map((f) => [f.id, f.status]));
      for (const [id, status] of ids) history.run({ id, status, reason });
      moved += ids.size;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return moved;
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

export type JobKind = "commit" | "comment" | "overview";
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

/**
 * Due jobs, oldest first, overviews after reviews of PRs: at most one per project, none for a
 * project with a running job.
 */
export function listDueJobs(limit: number): ReviewJob[] {
  const rows = getDb()
    .prepare(
      `${JOB_SELECT}
       WHERE j.status = 'queued' AND j.run_after <= datetime('now')
         AND pr.project_id NOT IN (
           SELECT p2.project_id FROM review_jobs j2
           JOIN pull_requests p2 ON p2.id = j2.pull_request_id WHERE j2.status = 'running')
       ORDER BY j.kind = 'overview', j.run_after, j.id`,
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

/**
 * The job's required check was concluded without a review: "deadline", "limit" (daily count
 * of reviews) or "budget" (daily tokens of the project or of the service).
 */
export function markCheckConcluded(id: number, note: "deadline" | "limit" | "budget"): void {
  getDb()
    .prepare(
      `UPDATE review_jobs SET check_concluded = 1, note = @note, updated_at = datetime('now')
       WHERE id = @id`,
    )
    .run({ id, note });
}

/** Signs that reviews are not getting done; empty when the queue is healthy. */
export function queueProblems(): string[] {
  const row = getDb()
    .prepare(
      `SELECT
         SUM(status = 'queued' AND last_error IS NOT NULL
             AND COALESCE(note, '') NOT IN ('limit', 'budget')) AS retrying,
         SUM(status = 'failed' AND updated_at > datetime('now', '-1 hour')) AS failed,
         SUM(note = 'deadline' AND updated_at > datetime('now', '-1 hour')) AS overdue
       FROM review_jobs`,
    )
    .get() as { retrying: number | null; failed: number | null; overdue: number | null };
  const problems: string[] = [];
  if (row.retrying) problems.push(`${row.retrying} review job(s) retrying after an error`);
  if (row.failed) problems.push(`${row.failed} review job(s) failed for good in the last hour`);
  if (row.overdue) problems.push(`${row.overdue} check(s) concluded "not reviewed" in the last hour`);
  return problems;
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
  headRef: string | null;
  mergedIntoDefault: boolean;
} | null {
  const row = getDb()
    .prepare(
      `SELECT id, project_id AS projectId, number, head_sha AS headSha, author_login AS author,
              title, state, head_ref AS headRef, merged_into_default AS merged
       FROM pull_requests WHERE id = @prId`,
    )
    .get({ prId }) as
    | (Omit<NonNullable<ReturnType<typeof getPullRequest>>, "mergedIntoDefault"> & { merged: number })
    | undefined;
  if (!row) return null;
  const { merged, ...rest } = row;
  return { ...rest, mergedIntoDefault: merged === 1 };
}
