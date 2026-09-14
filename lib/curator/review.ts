import { githubRequest } from "@/lib/github/api";
import { getInstallationToken } from "@/lib/github/auth";
import { concludeCheckRun, createCheckRun } from "@/lib/github/checks";
import { postIssueComment } from "@/lib/github/comments";
import { chat } from "@/lib/llm/chat";
import {
  applyReconciliation,
  getProjectByRepo,
  hasSuccessfulCommitAnalysis,
  loadOpenFindings,
  loadStudentResponses,
  recordAnalysis,
  saveStudentResponse,
  upsertParticipant,
  upsertPullRequest,
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
ведёшь память находок между проверками одного и того же pull request.

Ищи существенные методические и содержательные ошибки, способные повлиять на выводы работы:
утечка данных между обучающей и тестовой выборками, некорректное разделение данных,
дубликаты в датасете, неподходящая метрика, невоспроизводимость эксперимента, расхождение
между описанием проекта и фактической реализацией, ошибки в коде, меняющие результат без
явного сбоя.

Тебе даются: изменения PR, описание исследования, СПИСОК ПРОШЛЫХ НАХОДОК этого PR (с их id
и статусом) и ОТВЕТЫ СТУДЕНТА. Твоя задача — сверить прошлые находки с текущим состоянием и
выдать актуальный список.

Правила разбора:
- Каждую находку подтверждай конкретным фрагментом кода или данных из изменений. Находку без
  подтверждения не включай.
- Прошлые находки сверяй по существу, а не по формулировке. Для каждой прошлой находки reши:
  - "open" — проблема всё ещё присутствует и не решена;
  - "closed" — из изменений видно, что она исправлена;
  - "dismissed" — студент дал объяснение, и оно по существу снимает замечание (прими его);
  - "reopened" — была закрыта/снята, но снова появилась.
  В поле prior_id укажи id той прошлой находки, к которой относится статус.
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
      "category": "краткая категория",
      "severity": "high" | "medium" | "low",
      "title": "короткий заголовок находки",
      "file": "путь к файлу или null",
      "lines": "строки/диапазон или null",
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

function buildChangesText(files: PrFile[]): string {
  let out = "";
  for (const file of files) {
    const header = `### ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})\n`;
    const body = file.patch
      ? "```diff\n" + file.patch + "\n```\n"
      : "(изменения без текстового diff — бинарный или слишком большой файл)\n";
    if (out.length + header.length + body.length > MAX_PATCH_CHARS) {
      out += "\n_(часть изменений обрезана из-за объёма)_\n";
      break;
    }
    out += header + body + "\n";
  }
  return out.trim() === "" ? "(нет текстовых изменений)" : out;
}

function buildPriorFindingsText(findings: PriorFinding[]): string {
  if (findings.length === 0) {
    return "Прошлых находок по этому pull request нет.";
  }
  const lines = findings.map(
    (f) =>
      `- id=${f.id} [${f.status}] (${f.category ?? "без категории"}, ${f.severity ?? "?"}) ` +
      `${f.title}${f.file ? ` — ${f.file}${f.lines ? `:${f.lines}` : ""}` : ""}`,
  );
  return `Прошлые находки этого pull request:\n${lines.join("\n")}`;
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
  files: PrFile[],
  prNumber: number,
  prior: PriorFinding[],
  responses: StudentResponse[],
): string {
  const researchBlock = research
    ? `Описание исследования (RESEARCH.md):\n${research}\n\n`
    : "Описание исследования (RESEARCH.md) в репозитории не найдено.\n\n";
  return (
    researchBlock +
    `${buildPriorFindingsText(prior)}\n\n` +
    `${buildResponsesText(responses)}\n\n` +
    `Изменения в pull request #${prNumber}:\n\n${buildChangesText(files)}`
  );
}

const VALID_STATUSES = new Set(["open", "closed", "dismissed", "reopened", "pending"]);

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
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim() !== "" ? v.trim() : null;
    findings.push({
      priorId,
      status,
      category: str(f.category),
      severity: str(f.severity),
      title,
      file: str(f.file),
      lines: str(f.lines),
      evidence: str(f.evidence),
      impact: str(f.impact),
      recommendation: str(f.recommendation),
      reason: str(f.reason),
    });
  }

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  return { summary, findings };
}

function renderComment(result: ReconcileResult, changes: StatusChange[]): string {
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
      const loc = f.file ? ` — \`${f.file}${f.lines ? `:${f.lines}` : ""}\`` : "";
      const badge = f.status === "reopened" ? " (открыта повторно)" : "";
      parts.push(`### ${f.title}${badge}`);
      parts.push(
        `_${f.category ?? "без категории"} · серьёзность: ${f.severity ?? "?"}_${loc}`,
        "",
      );
      if (f.impact) parts.push(`**Влияние:** ${f.impact}`);
      if (f.evidence) parts.push(`**Подтверждение:** ${f.evidence}`);
      if (f.recommendation) parts.push(`**Что сделать:** ${f.recommendation}`);
      parts.push("");
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

interface ReviewOutcome {
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

  const answer = await chat([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: buildUserPrompt(research, files, params.prNumber, prior, responses),
    },
  ]);

  const parsed = parseModelJson(answer);
  const provider = process.env.LLM_PROVIDER ?? null;
  const model = process.env.LLM_MODEL ?? null;

  if (!parsed) {
    // Не смогли разобрать JSON — не портим память, публикуем сырой текст.
    recordAnalysis({ prId, headSha: params.headSha, trigger, outcome: "parse_error", provider, model });
    return {
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
  });
  const { statusChanges } = applyReconciliation(prId, analysisId, parsed);

  return {
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
    const { comment } = await runReview(params, prId, "commit");
    await postIssueComment({
      owner: params.owner,
      repo: params.repo,
      issueNumber: params.prNumber,
      body: comment,
      installationId: params.installationId,
    });
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

  let statusChanges: StatusChange[];
  try {
    ({ statusChanges } = await runReview(reviewParams, prId, "comment"));
  } catch (error) {
    // Сбой должен быть виден в памяти (и в панели), а не только в логе.
    recordAnalysis({ prId, headSha: pr.head.sha, trigger: "comment", outcome: "error" });
    throw error;
  }
  const resolved = statusChanges.filter(
    (c) => c.newStatus === "closed" || c.newStatus === "dismissed",
  );
  if (resolved.length === 0) {
    return; // ничего не сняли — не шумим в PR
  }

  const lines = resolved.map((c) => {
    const label = c.newStatus === "closed" ? "исправлено" : "снято по объяснению";
    return `- ${c.title} — ${label}${c.reason ? ` (${c.reason})` : ""}`;
  });
  await postIssueComment({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.prNumber,
    body: `${COMMENT_MARKER}\n\nУчёл ответ. Обновления по находкам:\n${lines.join("\n")}`,
    installationId: params.installationId,
  });
}
