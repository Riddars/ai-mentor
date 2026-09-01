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
  info: { author?: string | null; title?: string | null; state?: string | null } = {},
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
  outcome: "ok" | "parse_error" | "error";
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
       WHERE pull_request_id = @prId AND status IN ('open', 'reopened', 'pending')
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
