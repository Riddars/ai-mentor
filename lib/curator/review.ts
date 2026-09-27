import { githubRequest } from "@/lib/github/api";
import { getInstallationToken } from "@/lib/github/auth";
import { concludeCheckRun, createCheckRun } from "@/lib/github/checks";
import { postIssueComment } from "@/lib/github/comments";
import { chat, type ChatMessage } from "@/lib/llm/chat";
import {
  FINDING_AREAS,
  LOCATION_KINDS,
  type FindingArea,
  type FindingLocation,
  type LocationKind,
  type Severity,
} from "@/lib/curator/finding";
import { areaLabel, locationText, severityLabel } from "@/lib/format";
import {
  applyReconciliation,
  enqueueCommitJob,
  finishJob,
  getJobCheckRun,
  getPullRequest,
  setJobCheckRun,
  getPullRequestHead,
  hasJobForHead,
  getProjectByRepo,
  hasSuccessfulCommitAnalysis,
  loadOpenFindings,
  loadStudentResponses,
  recordAnalysis,
  setAnalysisComment,
  upsertParticipant,
  upsertPullRequest,
  type AnalysisMaterials,
  type FindingStatus,
  type KeptFinding,
  type PriorFinding,
  type PullRequestState,
  type ReconcileResult,
  type ReconciledFinding,
  type StatusChange,
  type StudentResponse,
} from "@/lib/curator/store";

/** Общие координаты pull request, которые нужны на каждом шаге разбора. */
export interface ReviewParams {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  installationId: number;
  author?: string | null;
  title?: string | null;
  /** Real PR state; defaults to "open" (commit events only arrive for open PRs). */
  state?: PullRequestState;
}

// Потолок на суммарный объём патчей в промпте: страховка от разового гигантского
// PR, а не тонкая настройка. Крупнее — обрезаем и честно помечаем это в тексте.
const MAX_PATCH_CHARS = 50_000;

const COMMENT_MARKER = "🤖 **AI Curator**";

interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

const SYSTEM_PROMPT = `Ты — ИИ-куратор студенческих исследований на стыке химии и машинного обучения.
Ты разбираешь изменения из pull request в контексте исследовательской задачи проекта и
ведёшь память находок проекта между проверками: находка, поднятая в одном pull request,
может быть исправлена в следующем.

Ищи существенные методические и содержательные ошибки, способные повлиять на выводы работы:
утечка данных между обучающей и тестовой выборками, некорректное разделение данных,
дубликаты в датасете, неподходящая метрика, невоспроизводимость эксперимента, расхождение
между описанием проекта и фактической реализацией, ошибки в коде, меняющие результат без
явного сбоя, логические ошибки в рассуждениях и выводах.

Каждой находке назначь ровно одну область (area):
- "code" — ошибка в коде, меняющая результат без явного сбоя;
- "data" — качество и обработка данных: дубликаты, пропуски, выбросы, некорректная очистка;
- "methodology" — схема эксперимента: разбиение, утечка, валидация, метрики, бейзлайны;
- "reproducibility" — воспроизводимость: сиды, версии, окружение, недостающие шаги;
- "problem" — постановка задачи: цель, гипотеза или целевая переменная сформулированы
  неверно или не проверяемо;
- "reasoning" — научная логика: выводы не следуют из результатов, противоречия,
  необоснованные допущения;
- "novelty" — новизна и научный контекст: задача уже решена известными методами, упущены
  стандартные подходы;
- "plan" — расхождение между описанием исследования и фактической работой.

Серьёзность (severity):
- "critical" — может исказить результаты или выводы работы;
- "important" — снижает надёжность или качество работы, но выводы, вероятно, устоят;
- "info" — стоит учесть, на выводы не влияет.

Основания (locations) — список мест, на которые опирается находка; их может быть несколько
(проблема проходит через несколько файлов) или ни одного конкретного места (логическая
ошибка). Вид места (kind): "file" — файл репозитория (detail — строки), "document" —
документ или его раздел (например, RESEARCH.md), "data" — набор данных, "other" — иное.

Тебе даются: изменения PR, описание исследования, СПИСОК ОТКРЫТЫХ НАХОДОК ПРОЕКТА (с их id,
номером PR, где находка поднята, и статусом) и ОТВЕТЫ СТУДЕНТА в этом PR. Твоя задача —
сверить прошлые находки с текущим состоянием и выдать актуальный список.

Правила разбора:
- Каждую находку подтверждай конкретным фрагментом кода, данных или текста описания
  исследования. Находку без подтверждения не включай.
- Прошлые находки сверяй по существу, а не по формулировке. Для каждой прошлой находки reши:
  - "open" — проблема всё ещё присутствует и не решена;
  - "closed" — из изменений видно, что она исправлена;
  - "dismissed" — студент дал объяснение, и оно по существу снимает замечание (прими его);
  - "reopened" — была закрыта/снята, но снова появилась.
  В поле prior_id укажи id той прошлой находки, к которой относится статус.
- Находки этого PR сверяй все. Находки из других PR включай в ответ, только если изменения
  этого PR или ответ студента их касаются: исправляют ("closed") или объясняют
  ("dismissed"). Не касаются — не упоминай их: такие находки остаются как есть. Не
  закрывай находку из другого PR, если исправление не видно в изменениях.
- Если проблема из прошлой находки встречается и в этом PR, не создавай новую — укажи
  prior_id прошлой.
- Новые находки давай с prior_id: null и статусом "open".
- Не поднимай заново находку, которую студент уже объяснил и ты счёл объяснение принятым,
  если не появилось новых оснований.
- reason — короткое пояснение, почему выбран статус (особенно для closed/dismissed/reopened).

Отвечай СТРОГО одним JSON-объектом, без текста вокруг и без Markdown-ограждения:
{
  "summary": "краткое описание проверенных изменений (1-3 предложения, на русском)",
  "findings": [
    {
      "prior_id": <число или null>,
      "status": "open" | "closed" | "dismissed" | "reopened",
      "area": "code" | "data" | "methodology" | "reproducibility" | "problem" | "reasoning" | "novelty" | "plan",
      "severity": "critical" | "important" | "info",
      "title": "суть проблемы одной фразой простым языком",
      "description": "что не так, подробнее (2-4 предложения)",
      "locations": [
        { "kind": "file" | "document" | "data" | "other", "target": "путь, название документа или краткое описание", "detail": "строки, раздел или null" }
      ],
      "evidence": "подтверждающий фрагмент",
      "impact": "чем грозит результатам",
      "recommendation": "как проверить или исправить",
      "reason": "почему выбран этот статус или null"
    }
  ]
}
Все текстовые поля — на русском. Если существенных проблем нет — верни пустой массив findings.`;

async function fetchChangedFiles(params: ReviewParams): Promise<PrFile[]> {
  const token = await getInstallationToken(params.installationId);
  return githubRequest<PrFile[]>(
    `/repos/${params.owner}/${params.repo}/pulls/${params.prNumber}/files?per_page=100`,
    { token },
  );
}

/** Описание исследования из шаблона. Файла может не быть — это не ошибка разбора. */
async function fetchResearchDoc(params: ReviewParams): Promise<string | null> {
  const token = await getInstallationToken(params.installationId);
  try {
    const data = await githubRequest<{ content: string; encoding: string }>(
      `/repos/${params.owner}/${params.repo}/contents/RESEARCH.md?ref=${params.headSha}`,
      { token },
    );
    if (data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf8");
    }
    return data.content;
  } catch {
    return null;
  }
}

function buildChangesText(files: PrFile[]): { text: string; truncated: boolean } {
  let out = "";
  let truncated = false;
  for (const file of files) {
    const header = `### ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})\n`;
    const body = file.patch
      ? "```diff\n" + file.patch + "\n```\n"
      : "(изменения без текстового diff — бинарный или слишком большой файл)\n";
    if (out.length + header.length + body.length > MAX_PATCH_CHARS) {
      out += "\n_(часть изменений обрезана из-за объёма)_\n";
      truncated = true;
      break;
    }
    out += header + body + "\n";
  }
  return { text: out.trim() === "" ? "(нет текстовых изменений)" : out, truncated };
}

function buildPriorFindingsText(findings: PriorFinding[], prNumber: number): string {
  if (findings.length === 0) {
    return "Открытых находок по проекту нет.";
  }
  const lines = findings.map((f) => {
    const where = f.locations.length > 0 ? ` — ${f.locations.map(locationText).join("; ")}` : "";
    const origin = f.prNumber === prNumber ? "этот PR" : `PR #${f.prNumber}`;
    return (
      `- id=${f.id} [${f.status}] (${origin}; ${f.area ?? "без области"}, ${f.severity ?? "?"}) ` +
      `${f.title}${where}`
    );
  });
  return `Открытые находки проекта:\n${lines.join("\n")}`;
}

function buildResponsesText(responses: StudentResponse[]): string {
  if (responses.length === 0) {
    return "Ответов студента по этому pull request нет.";
  }
  const lines = responses.map(
    (r) =>
      `- ${r.login ?? "студент"}${r.findingId ? ` (к находке id=${r.findingId})` : ""}: ` +
      `${(r.body ?? "").trim()}`,
  );
  return `Ответы студента:\n${lines.join("\n")}`;
}

function buildUserPrompt(
  research: string | null,
  changes: string,
  prNumber: number,
  prior: PriorFinding[],
  responses: StudentResponse[],
): string {
  const researchBlock = research
    ? `Описание исследования (RESEARCH.md):\n${research}\n\n`
    : "Описание исследования (RESEARCH.md) в репозитории не найдено.\n\n";
  return (
    researchBlock +
    `${buildPriorFindingsText(prior, prNumber)}\n\n` +
    `${buildResponsesText(responses)}\n\n` +
    `Изменения в pull request #${prNumber}:\n\n${changes}`
  );
}

const VALID_STATUSES = new Set(["open", "closed", "dismissed", "reopened", "pending"]);

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

// Older answers used high/medium/low; they map onto the current three levels.
const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: "critical",
  high: "critical",
  important: "important",
  medium: "important",
  info: "info",
  low: "info",
};

function parseSeverity(raw: string | null): Severity | null {
  return raw ? (SEVERITY_ALIASES[raw.toLowerCase()] ?? null) : null;
}

/** Locations from the answer; a legacy single file/lines pair becomes one file location. */
function parseLocations(f: Record<string, unknown>): FindingLocation[] {
  if (!Array.isArray(f.locations)) {
    const file = str(f.file);
    return file ? [{ kind: "file", target: file, detail: str(f.lines) }] : [];
  }
  const out: FindingLocation[] = [];
  for (const item of f.locations) {
    if (typeof item !== "object" || item === null) continue;
    const loc = item as Record<string, unknown>;
    const target = str(loc.target);
    if (!target) continue;
    const kind = str(loc.kind);
    out.push({
      kind: LOCATION_KINDS.includes(kind as LocationKind) ? (kind as LocationKind) : "other",
      target,
      detail: str(loc.detail),
    });
  }
  return out;
}

/** Достать JSON из ответа модели (в т.ч. из ```json-блока) и привести к ReconcileResult. */
export function parseModelJson(raw: string): ReconcileResult | null {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  } else {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      text = text.slice(first, last + 1);
    }
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) {
    return null;
  }

  const findings: ReconciledFinding[] = [];
  for (const item of obj.findings) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const f = item as Record<string, unknown>;
    const title = typeof f.title === "string" ? f.title.trim() : "";
    if (title === "") {
      continue;
    }
    const status =
      typeof f.status === "string" && VALID_STATUSES.has(f.status)
        ? (f.status as ReconciledFinding["status"])
        : "open";
    const priorId =
      typeof f.prior_id === "number" && Number.isInteger(f.prior_id) ? f.prior_id : null;
    const area = str(f.area);
    findings.push({
      priorId,
      status,
      area: FINDING_AREAS.includes(area as FindingArea) ? (area as FindingArea) : null,
      severity: parseSeverity(str(f.severity)),
      title,
      description: str(f.description),
      locations: parseLocations(f),
      evidence: str(f.evidence),
      impact: str(f.impact),
      recommendation: str(f.recommendation),
      reason: str(f.reason),
    });
  }

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  return { summary, findings };
}

export function renderComment(result: ReconcileResult, changes: StatusChange[]): string {
  const open = result.findings.filter(
    (f) => f.status === "open" || f.status === "reopened",
  );

  const parts: string[] = [COMMENT_MARKER, ""];
  if (result.summary) {
    parts.push(result.summary, "");
  }

  if (open.length === 0) {
    parts.push("Существенных методических проблем в этих изменениях не нашёл.");
  } else {
    parts.push(`**Существенные находки (${open.length}):**`, "");
    for (const f of open) {
      const badge = f.status === "reopened" ? " (открыта повторно)" : "";
      parts.push(`### ${f.title}${badge}`);
      parts.push(`_${areaLabel(f.area ?? null)} · ${severityLabel(f.severity ?? null)}_`, "");
      if (f.description) parts.push(f.description, "");
      if (f.impact) parts.push(`**Почему это важно:** ${f.impact}`, "");
      if (f.locations && f.locations.length > 0) {
        parts.push("**Основания:**");
        for (const l of f.locations) {
          parts.push(`- ${l.kind === "other" ? locationText(l) : `\`${locationText(l)}\``}`);
        }
        parts.push("");
      }
      if (f.evidence) parts.push(`**Подтверждение:** ${f.evidence}`, "");
      if (f.recommendation) parts.push(`**Что сделать:** ${f.recommendation}`, "");
    }
  }

  const resolved = changes.filter((c) => RESOLVED_LABEL[c.newStatus]);
  if (resolved.length > 0) {
    parts.push("---", "**С прошлой проверки:**");
    for (const c of resolved) {
      parts.push(`- ${c.title} — ${RESOLVED_LABEL[c.newStatus]}${c.reason ? ` (${c.reason})` : ""}`);
    }
    parts.push("");
  }

  parts.push("_Решение по каждой находке остаётся за студентом._");
  return parts.join("\n");
}

/** Short reply after a student's comment; null when nothing was closed or dismissed. */
export function renderReplyComment(changes: StatusChange[], kept: KeptFinding[]): string | null {
  const resolved = changes.filter((c) => RESOLVED_LABEL[c.newStatus]);
  if (resolved.length === 0 && kept.length === 0) return null;
  const parts: string[] = [COMMENT_MARKER, "", "Учёл ответ."];
  if (resolved.length > 0) {
    parts.push("", "**Обновления по находкам:**");
    for (const c of resolved) {
      parts.push(`- ${c.title} — ${RESOLVED_LABEL[c.newStatus]}${c.reason ? ` (${c.reason})` : ""}`);
    }
  }
  if (kept.length > 0) {
    parts.push("", "**Объяснение не сняло замечание:**");
    for (const k of kept) {
      parts.push(`- ${k.title}${k.reason ? ` — ${k.reason}` : ""}`);
    }
  }
  return parts.join("\n");
}

// What the student is told about a finding that stopped being open.
const RESOLVED_LABEL: Partial<Record<FindingStatus, string>> = {
  pending: "исправлено, закроется после слияния в основную ветку",
  closed: "исправлено",
  dismissed: "снято по объяснению",
};

interface ReviewOutcome {
  analysisId: number;
  comment: string;
  outcome: "ok" | "parse_error";
  summary: string;
  statusChanges: StatusChange[];
  kept: KeptFinding[];
}

/**
 * Собрать контекст, спросить модель, сохранить находки и вернуть готовый комментарий.
 * Персист (analyses / findings / история статусов) происходит здесь.
 */
async function runReview(
  params: ReviewParams,
  prId: number,
  trigger: "commit" | "comment",
  context: { isCurrent?: () => boolean; fixesFinal?: () => boolean } = {},
): Promise<ReviewOutcome> {
  const [files, research] = await Promise.all([
    fetchChangedFiles(params),
    fetchResearchDoc(params),
  ]);
  const prior = loadOpenFindings(prId);
  const responses = loadStudentResponses(prId);
  const changes = buildChangesText(files);
  const materials: AnalysisMaterials = {
    files: files.map((f) => f.filename),
    researchDoc: research !== null,
    truncated: changes.truncated,
    priorFindings: prior.length,
    studentResponses: responses.length,
  };

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: buildUserPrompt(research, changes.text, params.prNumber, prior, responses),
    },
  ];
  // One retry when the answer is not valid JSON: models occasionally wrap or cut it.
  let answer = await chat(messages);
  let parsed = parseModelJson(answer.content);
  if (!parsed) {
    answer = await chat(messages);
    parsed = parseModelJson(answer.content);
  }
  const record = {
    prId,
    headSha: params.headSha,
    trigger,
    provider: answer.provider,
    model: answer.model,
    materials,
    rawResponse: answer.content,
  };

  if (context.isCurrent && !context.isCurrent()) {
    // Пока модель думала, пришёл новый коммит или PR закрыли без слияния: результат не
    // применяем, но обращение к модели учитываем (дневной лимит, панель).
    recordAnalysis({ ...record, outcome: "stale", summary: parsed?.summary || null });
    throw new StaleReviewError();
  }

  if (!parsed) {
    // Память не портим; сырой ответ сохранён в разборе и виден руководителю в панели,
    // в публичный PR он не попадает.
    const analysisId = recordAnalysis({ ...record, outcome: "parse_error" });
    return {
      analysisId,
      comment:
        `${COMMENT_MARKER}\n\nРазбор не удался: ответ модели не удалось разобрать. ` +
        "Подробности — у руководителя в панели.",
      outcome: "parse_error",
      summary: "",
      statusChanges: [],
      kept: [],
    };
  }

  const analysisId = recordAnalysis({ ...record, outcome: "ok", summary: parsed.summary || null });
  const { statusChanges, kept } = applyReconciliation(prId, analysisId, parsed, {
    allowedPriorIds: new Set(prior.map((f) => f.id)),
    allowNew: trigger === "commit",
    fixesFinal: context.fixesFinal?.() ?? false,
  });

  return {
    analysisId,
    comment: renderComment(parsed, statusChanges),
    outcome: "ok",
    summary: parsed.summary,
    statusChanges,
    kept,
  };
}

/**
 * Записать участника/PR и вернуть id pull request в памяти. Проект не создаётся:
 * разбираются только подключённые в управлении проекты (вебхук отсекает
 * остальные), поэтому удалённый проект здесь не воскресает.
 */
function persistPrContext(params: ReviewParams): number {
  const project = getProjectByRepo(params.owner, params.repo);
  if (!project) {
    throw new Error(`Project ${params.owner}/${params.repo} is not connected`);
  }
  if (params.author) {
    upsertParticipant(project.id, params.author);
  }
  return upsertPullRequest(project.id, params.prNumber, {
    author: params.author,
    title: params.title,
    state: params.state ?? "open",
    headSha: params.headSha,
  });
}

/** Timing of the review queue; overridable from the environment. */
export function queueSettings() {
  const num = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    debounceMs: num("REVIEW_DEBOUNCE_MS", 120_000),
    deadlineMs: num("REVIEW_DEADLINE_MS", 30 * 60_000),
    dailyLimit: num("REVIEW_DAILY_LIMIT", 50),
    retryWindowMs: num("REVIEW_RETRY_WINDOW_MS", 24 * 60 * 60_000),
    concurrency: Math.max(1, num("REVIEW_CONCURRENCY", 3)),
  };
}

/** Where a commit review request comes from. */
export type ReviewSource = "webhook" | "sync" | "rerun" | "restart";

/** Current head and state of a PR on GitHub — the source of truth outside webhooks. */
async function fetchLivePullRequest(
  params: ReviewParams,
): Promise<{ headSha: string; open: boolean }> {
  const token = await getInstallationToken(params.installationId);
  const pr = await githubRequest<{ head: { sha: string }; state: string }>(
    `/repos/${params.owner}/${params.repo}/pulls/${params.prNumber}`,
    { token },
  );
  return { headSha: pr.head.sha, open: pr.state === "open" };
}

/**
 * Поставить разбор коммита в очередь и поставить обязательную проверку (она блокирует
 * слияние до разбора или до срока). Источник:
 * - `webhook` — событие коммита; разбор через задержку (разбирается только последний коммит);
 * - `sync` — сверка с GitHub: только коммиты, по которым задачи ещё не было;
 * - `rerun` — «Re-run» в GitHub: разобрать заново, даже если коммит уже разобран;
 * - `restart` — кнопка в панели: разобрать последний коммит, если он ещё не разобран.
 * Вне вебхука последний коммит берётся из GitHub: запрос по устаревшему коммиту
 * пропускается и не откатывает head в памяти.
 */
export async function startCommitReview(
  params: ReviewParams,
  source: ReviewSource,
): Promise<"queued" | "skipped"> {
  if (source !== "webhook") {
    const live = await fetchLivePullRequest(params);
    if (!live.open) return "skipped";
    // A restart from the panel reviews whatever is the head now; other sources only the
    // commit they were asked about.
    if (source === "restart") params = { ...params, headSha: live.headSha };
    else if (live.headSha !== params.headSha) return "skipped";
  }

  // Synchronous from here to the insert: no other event can interleave.
  const prId = persistPrContext(params);
  if (hasJobForHead(prId, params.headSha, source !== "sync")) {
    return "skipped"; // этот коммит уже в очереди (или, для сверки, уже пробовали)
  }
  // Only "Re-run" in GitHub reviews an already reviewed commit again: a person asked for it
  // explicitly. The panel button restarts only commits without a review.
  if (source !== "rerun" && hasSuccessfulCommitAnalysis(prId, params.headSha)) {
    return "skipped";
  }
  const settings = queueSettings();
  const { jobId, supersededCheckRunIds } = enqueueCommitJob({
    prId,
    headSha: params.headSha,
    payload: params,
    delayMs: source === "webhook" ? settings.debounceMs : 0,
    deadlineMs: settings.deadlineMs,
  });
  if (jobId === null) return "skipped";

  let checkRunId: number;
  try {
    checkRunId = await createCheckRun({
      owner: params.owner,
      repo: params.repo,
      headSha: params.headSha,
      installationId: params.installationId,
    });
  } catch (error) {
    finishJob(jobId, "superseded", "failed to create the check-run");
    throw error;
  }
  if (setJobCheckRun(jobId, checkRunId) === "done") {
    // The review finished before the check existed — conclude it now.
    await concludeCheck(params, checkRunId, "Разбор изменений завершён.");
  }
  for (const id of supersededCheckRunIds) {
    await concludeCheck(params, id, "Заменён новым коммитом — разбирается последний.").catch(
      (error) => console.error(`[curator] failed to conclude replaced check ${id}:`, error),
    );
  }
  return "queued";
}

/** Conclude a required check as success with a short note (no review happened). */
export async function concludeCheck(
  params: Pick<ReviewParams, "owner" | "repo" | "installationId">,
  checkRunId: number,
  summary: string,
): Promise<void> {
  await concludeCheckRun({
    owner: params.owner,
    repo: params.repo,
    checkRunId,
    conclusion: "success",
    output: { title: "AI Curator", summary },
    installationId: params.installationId,
  });
}

/** The PR moved on (new commit) or was closed without merge while it was being reviewed. */
export class StaleReviewError extends Error {
  constructor() {
    super("Pull request changed during the review");
  }
}

/**
 * Выполнить разбор коммита из очереди: разбор, комментарий, завершение проверки. Если head
 * PR сменился или PR закрыт без слияния, результат не применяется — StaleReviewError. Если
 * PR уже слит, исправления закрываются сразу (второго шага закрытия уже не будет).
 */
export async function executeCommitJob(
  params: ReviewParams,
  prId: number,
  jobId: number,
): Promise<void> {
  const isCurrent = () => {
    const pr = getPullRequest(prId);
    return pr !== null && pr.headSha === params.headSha && pr.state !== "closed";
  };
  if (!isCurrent()) throw new StaleReviewError();
  const { analysisId, comment } = await runReview(params, prId, "commit", {
    isCurrent,
    fixesFinal: () => getPullRequest(prId)?.state === "merged",
  });
  await postIssueComment({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.prNumber,
    body: comment,
    installationId: params.installationId,
  });
  setAnalysisComment(analysisId, comment);
  // The comment is out: from here on a failure must not repeat the review. The check is
  // updated also after an early "not reviewed" conclusion; if this fails, it stays as is.
  const checkRunId = getJobCheckRun(jobId);
  if (checkRunId !== null) {
    await concludeCheck(params, checkRunId, "Разбор изменений завершён.").catch((error) =>
      console.error(`[curator] failed to conclude check ${checkRunId}:`, error),
    );
  }
}

/**
 * Разбор не удался за всё окно повторов: записать сбой (виден в панели) и сообщить в PR.
 */
export async function reportReviewFailure(
  params: { owner: string; repo: string; prNumber: number; installationId: number; headSha?: string },
  prId: number,
  kind: "commit" | "comment",
): Promise<void> {
  recordAnalysis({
    prId,
    headSha: params.headSha ?? getPullRequestHead(prId) ?? "unknown",
    trigger: kind,
    outcome: "error",
  });
  if (kind === "commit") {
    await postIssueComment({
      owner: params.owner,
      repo: params.repo,
      issueNumber: params.prNumber,
      body:
        `${COMMENT_MARKER}\n\nНе удалось выполнить разбор изменений: сервис анализа был ` +
        "недоступен. Руководитель видит это в панели и может перезапустить разбор.",
      installationId: params.installationId,
    });
  }
}

/** Данные комментария студента, из которых запускается сверка по объяснению. */
export interface CommentReviewParams {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  commentId: number;
}

/**
 * Сверка по ответу студента (задача очереди; сам ответ уже сохранён вебхуком). Новый
 * check-run НЕ создаём: проверка уже завершена и слияние разрешено (куратор
 * совещательный). Сверяем статусы на текущем head PR и коротко отвечаем студенту.
 */
export async function executeCommentJob(params: CommentReviewParams): Promise<void> {
  const token = await getInstallationToken(params.installationId);
  const pr = await githubRequest<{
    head: { sha: string };
    user: { login: string };
    title: string;
    state: "open" | "closed";
    merged: boolean;
  }>(`/repos/${params.owner}/${params.repo}/pulls/${params.prNumber}`, { token });

  const reviewParams: ReviewParams = {
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    headSha: pr.head.sha,
    installationId: params.installationId,
    author: pr.user.login,
    title: pr.title,
    // Comments arrive for merged/closed PRs too — keep the real state in memory.
    state: pr.state === "open" ? "open" : pr.merged ? "merged" : "closed",
  };
  const prId = persistPrContext(reviewParams);
  if (loadOpenFindings(prId).length === 0) {
    return; // сверять нечего — модель не вызываем
  }

  const outcome = await runReview(reviewParams, prId, "comment", {
    fixesFinal: () => reviewParams.state === "merged",
  });
  const body = renderReplyComment(outcome.statusChanges, outcome.kept);
  if (!body) {
    return; // модель ничего не сказала о прошлых находках — не шумим в PR
  }
  await postIssueComment({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.prNumber,
    body,
    installationId: params.installationId,
  });
  setAnalysisComment(outcome.analysisId, body);
}
