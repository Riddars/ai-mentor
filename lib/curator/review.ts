import { githubRequest } from "@/lib/github/api";
import { getInstallationToken } from "@/lib/github/auth";
import { concludeCheckRun, createCheckRun } from "@/lib/github/checks";
import { postIssueComment } from "@/lib/github/comments";
import { chat } from "@/lib/llm/chat";
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
  getProjectByRepo,
  hasSuccessfulCommitAnalysis,
  loadOpenFindings,
  loadStudentResponses,
  recordAnalysis,
  saveStudentResponse,
  setAnalysisComment,
  upsertParticipant,
  upsertPullRequest,
  type AnalysisMaterials,
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

  const resolved = changes.filter(
    (c) => c.newStatus === "closed" || c.newStatus === "dismissed",
  );
  if (resolved.length > 0) {
    parts.push("---", "**С прошлой проверки:**");
    for (const c of resolved) {
      const label = c.newStatus === "closed" ? "исправлено" : "снято по объяснению";
      parts.push(`- ${c.title} — ${label}${c.reason ? ` (${c.reason})` : ""}`);
    }
    parts.push("");
  }

  parts.push("_Решение по каждой находке остаётся за студентом._");
  return parts.join("\n");
}

/** Short reply after a student's comment; null when nothing was closed or dismissed. */
export function renderReplyComment(changes: StatusChange[]): string | null {
  const resolved = changes.filter((c) => c.newStatus === "closed" || c.newStatus === "dismissed");
  if (resolved.length === 0) return null;
  const lines = resolved.map((c) => {
    const label = c.newStatus === "closed" ? "исправлено" : "снято по объяснению";
    return `- ${c.title} — ${label}${c.reason ? ` (${c.reason})` : ""}`;
  });
  return `${COMMENT_MARKER}\n\nУчёл ответ. Обновления по находкам:\n${lines.join("\n")}`;
}

interface ReviewOutcome {
  analysisId: number;
  comment: string;
  outcome: "ok" | "parse_error";
  summary: string;
  statusChanges: StatusChange[];
}

/**
 * Собрать контекст, спросить модель, сохранить находки и вернуть готовый комментарий.
 * Персист (analyses / findings / история статусов) происходит здесь.
 */
async function runReview(
  params: ReviewParams,
  prId: number,
  trigger: "commit" | "comment",
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

  const answer = await chat([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: buildUserPrompt(research, changes.text, params.prNumber, prior, responses),
    },
  ]);

  const parsed = parseModelJson(answer);
  const provider = process.env.LLM_PROVIDER ?? null;
  const model = process.env.LLM_MODEL ?? null;

  if (!parsed) {
    // Не смогли разобрать JSON — не портим память, публикуем сырой текст.
    const analysisId = recordAnalysis({
      prId,
      headSha: params.headSha,
      trigger,
      outcome: "parse_error",
      provider,
      model,
      materials,
    });
    return {
      analysisId,
      comment: `${COMMENT_MARKER}\n\n${answer}`,
      outcome: "parse_error",
      summary: "",
      statusChanges: [],
    };
  }

  const analysisId = recordAnalysis({
    prId,
    headSha: params.headSha,
    trigger,
    outcome: "ok",
    summary: parsed.summary || null,
    provider,
    model,
    materials,
  });
  const { statusChanges } = applyReconciliation(prId, analysisId, parsed);

  return {
    analysisId,
    comment: renderComment(parsed, statusChanges),
    outcome: "ok",
    summary: parsed.summary,
    statusChanges,
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
  });
}

/**
 * Точка входа разбора языковой моделью для webhook-обработчика (событие коммита).
 * Обязательную проверку ставим сразу (она блокирует слияние), а сам разбор
 * запускаем в фоне, чтобы не держать ответ на вебхук на время обращения к модели.
 */
export async function handleLlmPullRequest(params: ReviewParams): Promise<void> {
  const prId = persistPrContext(params);
  if (hasSuccessfulCommitAnalysis(prId, params.headSha)) {
    // Повторная доставка вебхука для того же коммита — уже разобрали, выходим.
    console.log(`[curator] head ${params.headSha} already analysed, skipping`);
    return;
  }
  const checkRunId = await createCheckRun({
    owner: params.owner,
    repo: params.repo,
    headSha: params.headSha,
    installationId: params.installationId,
  });
  void completeReview(params, prId, checkRunId).catch((error) => {
    console.error("[curator] unhandled review failure:", error);
  });
}

async function completeReview(
  params: ReviewParams,
  prId: number,
  checkRunId: number,
): Promise<void> {
  try {
    const { analysisId, comment } = await runReview(params, prId, "commit");
    await postIssueComment({
      owner: params.owner,
      repo: params.repo,
      issueNumber: params.prNumber,
      body: comment,
      installationId: params.installationId,
    });
    setAnalysisComment(analysisId, comment);
    await concludeCheckRun({
      owner: params.owner,
      repo: params.repo,
      checkRunId,
      conclusion: "success",
      output: { title: "AI Curator", summary: "Разбор изменений завершён." },
      installationId: params.installationId,
    });
  } catch (error) {
    console.error("[curator] llm review failed:", error);
    try {
      recordAnalysis({ prId, headSha: params.headSha, trigger: "commit", outcome: "error" });
    } catch (recordError) {
      // The PR may have been deleted meanwhile (project removed in the panel).
      console.error("[curator] failed to record error outcome:", recordError);
    }
    // Отсутствие ответа не должно превращаться в разрешение: оставляем слияние
    // заблокированным (action_required) и сообщаем об этом в pull request.
    try {
      await postIssueComment({
        owner: params.owner,
        repo: params.repo,
        issueNumber: params.prNumber,
        body:
          `${COMMENT_MARKER}\n\nНе удалось выполнить разбор изменений: сервис анализа ` +
          "недоступен. Слияние остаётся заблокированным до ручной проверки ответственным " +
          "сотрудником.",
        installationId: params.installationId,
      });
      await concludeCheckRun({
        owner: params.owner,
        repo: params.repo,
        checkRunId,
        conclusion: "action_required",
        output: { title: "AI Curator", summary: "Разбор не выполнен — сервис недоступен." },
        installationId: params.installationId,
      });
    } catch (reportError) {
      console.error("[curator] failed to report llm error:", reportError);
    }
  }
}

/** Данные комментария студента, из которых запускается сверка по объяснению. */
export interface CommentReviewParams {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  commentId: number;
  commentBody: string;
  commenterLogin: string | null;
}

/**
 * Реакция на ответ студента без нового коммита. Новый check-run НЕ создаём: проверка
 * уже завершена и слияние разрешено (куратор совещательный). Сохраняем ответ, запускаем
 * сверку на текущем head PR и, если статусы находок изменились, коротко сообщаем об этом.
 */
export async function handleStudentComment(params: CommentReviewParams): Promise<void> {
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

  const isNew = saveStudentResponse({
    prId,
    commentId: params.commentId,
    login: params.commenterLogin,
    body: params.commentBody,
  });
  if (!isNew) {
    return; // этот комментарий уже обработан
  }

  let analysisId: number;
  let statusChanges: StatusChange[];
  try {
    ({ analysisId, statusChanges } = await runReview(reviewParams, prId, "comment"));
  } catch (error) {
    // Сбой должен быть виден в памяти (и в панели), а не только в логе.
    recordAnalysis({ prId, headSha: pr.head.sha, trigger: "comment", outcome: "error" });
    throw error;
  }
  const body = renderReplyComment(statusChanges);
  if (!body) {
    return; // ничего не сняли — не шумим в PR
  }
  await postIssueComment({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.prNumber,
    body,
    installationId: params.installationId,
  });
  setAnalysisComment(analysisId, body);
}
