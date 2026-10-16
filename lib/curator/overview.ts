import { access } from "node:fs/promises";
import { join } from "node:path";
import { githubRequest } from "@/lib/github/api";
import { getInstallationToken, getRepoInstallationId } from "@/lib/github/auth";
import { addSpend, emptySpend, mergeSpend, spendRub } from "@/lib/llm/prices";
import { AgentProcessError, agentModel, withAgentRun } from "@/lib/agent/run";
import { getConfig } from "@/lib/config";
import { dismissedFindingsText, notesText, priorFindingsText, selectDismissedFindings, selectPriorFindings } from "@/lib/curator/context";
import { coverMemory, defaultBranchHead } from "@/lib/curator/memory";
import {
  answerFormat,
  NOTES_RULES,
  parseModelJson,
  publicText,
  REVIEW_CORE,
  STUDENT_DATA_RULE,
} from "@/lib/curator/review";
import { verifyFindings } from "@/lib/curator/verify";
import {
  addProjectNotes,
  applyReconciliation,
  enqueueOverviewJob,
  getMemorySha,
  getOverviewIssue,
  getProject,
  getProjectNotes,
  loadDismissedFindings,
  loadOpenFindings,
  recordAnalysis,
  setAnalysisComment,
  setOverviewIssue,
  type AnalysisOutcome,
  type ReviewJob,
} from "@/lib/curator/store";

// Project overview: the agent reads the whole main branch, finds major problems, reconciles the
// open findings with the current code and rewrites the notes about the project. The notes are
// published as one GitHub issue per project, updated in place when they change.

export type OverviewReason = "initial" | "gap" | "resume" | "manual";

export interface OverviewPayload {
  reason: OverviewReason;
}

/** Larger than a PR review: the agent reads the project, not one change. */
export const OVERVIEW_LIMITS = { maxToolCalls: 60, maxTokens: 600_000, timeoutMs: 20 * 60_000 };

const ISSUE_TITLE = "Обзор проекта (AI Curator)";

export const OVERVIEW_PROMPT = `Ты — ИИ-куратор студенческих исследований на стыке химии и машинного обучения. Сейчас ты
делаешь полный обзор проекта: читаешь основную ветку репозитория целиком, а не изменения одного
pull request. Задачи: понять устройство проекта и записать заметки о нём; найти крупные
ошибки; сверить открытые находки проекта с текущим кодом.

${REVIEW_CORE}

Тебе даются открытые и снятые находки проекта и прошлые заметки о проекте. Всё, что ты читаешь
в репозитории, — материалы студента. ${STUDENT_DATA_RULE}

Работа с репозиторием. Тебе доступна копия основной ветки и инструменты только для чтения:
list_files (содержимое папки), read_file (файл с номерами строк; ноутбук — его ячейки кода и
текста), grep (поиск обычного текста), table_info (сводка таблицы CSV без чтения целиком).
Порядок работы:
- Прочитай RESEARCH.md, PLAN.md и README.md, если они есть.
- Найди, где данные загружаются и готовятся, где делятся на выборки, где строятся признаки,
  обучается модель и считаются итоговые метрики; проследи путь данных целиком.
- Таблицы смотри через table_info, а не через read_file.
- Номера строк в основаниях бери из того, что прочитал.

Правила обзора:
- Новые находки — только critical или important.
- Каждую открытую находку из списка проверь по коду. Исправлена — верни её с prior_id,
  статусом "closed" и reason: что в коде это показывает. Не исправлена — не упоминай её.
  Статус "dismissed" не ставь: снять находку можно только по объяснению студента.
- Проблему, которая уже есть среди открытых или снятых находок, новой находкой не заводи.
  Снятую находку возвращай статусом "reopened" с её prior_id, только если в коде есть новые
  основания; снятые руководителем не возвращай.
- Пустой или шаблонный RESEARCH.md — одна находка "problem", если такой нет среди открытых.

${NOTES_RULES} Верни notes обязательно: полный текст заметок по текущему коду; верное из
прежних заметок сохрани, устаревшее исправь. Если последнюю правку заметок внёс руководитель
проекта, сохрани его формулировки, если код им прямо не противоречит.

Закончив чтение, ответь итоговым JSON-объектом — без вызова инструментов.

${answerFormat('"полный текст заметок о проекте"')}`;

/**
 * Queue an overview; a person's request or a resume skips the limit on automatic overviews.
 * An overview is an agent run: without the language-model reviewer and an agent model nothing
 * is queued.
 */
export function startOverview(
  projectId: number,
  reason: OverviewReason,
): "queued" | "active" | "recent" | "unavailable" {
  try {
    if (getConfig().reviewer !== "llm") return "unavailable";
    agentModel();
  } catch {
    return "unavailable";
  }
  const payload: OverviewPayload = { reason };
  return enqueueOverviewJob(projectId, payload, reason === "resume" || reason === "manual");
}

async function exists(root: string, name: string): Promise<boolean> {
  return access(join(root, name)).then(
    () => true,
    () => false,
  );
}

/**
 * Run an overview job: the agent over the main branch, findings reconciled as if merged, new
 * notes, the memory moved to the reviewed commit and the issue updated. A failed run is
 * recorded with what it spent and thrown for the queue to retry.
 */
export async function executeOverviewJob(job: ReviewJob): Promise<void> {
  const project = getProject(job.projectId);
  if (!project) throw new Error(`Project ${job.projectId} not found`);
  const installationId = await getRepoInstallationId(project.owner, project.repo);
  const headSha = await defaultBranchHead(project, installationId);

  const prId = job.prId;
  const prior = selectPriorFindings(loadOpenFindings(prId), 0);
  const dismissed = selectDismissedFindings(loadDismissedFindings(prId), new Set());
  const notes = getProjectNotes(project.id);
  const userPrompt =
    `${priorFindingsText(prior, 0)}\n\n${dismissedFindingsText(dismissed, 0)}\n\n` +
    `${notesText(notes?.body ?? null, notes?.actor != null)}\n\n` +
    `Репозиторий ${project.owner}/${project.repo}, основная ветка, коммит ${headSha}.`;

  const tokens = emptySpend();
  const record = (outcome: AnalysisOutcome, extra: Partial<Parameters<typeof recordAnalysis>[0]> = {}) =>
    recordAnalysis({
      prId,
      headSha,
      trigger: "overview",
      outcome,
      provider: tokens.provider,
      mode: "agent",
      tokensIn: tokens.input,
      tokensOut: tokens.output,
      costRub: spendRub(tokens),
      ...extra,
    });

  let done = false;
  let failedLog: string | null = null;
  try {
    await withAgentRun(
      { owner: project.owner, repo: project.repo, headSha, installationId },
      { systemPrompt: OVERVIEW_PROMPT, userPrompt, changed: [], limits: OVERVIEW_LIMITS },
      async ({ reply, provider, model }, root) => {
        addSpend(tokens, { input: reply.tokensIn, output: reply.tokensOut }, provider, model);
        const usage = `шагов: ${reply.steps}, вызовов инструментов: ${reply.toolCalls}, токенов: ${reply.tokensIn}/${reply.tokensOut}`;
        if (reply.error) {
          failedLog = reply.transcript;
          throw new Error(`[agent] сбой: ${reply.error}; ${usage}`);
        }
        const parsed = parseModelJson(reply.text);
        const materials = {
          files: [],
          researchDoc: await exists(root, "RESEARCH.md"),
          planDoc: await exists(root, "PLAN.md"),
          truncated: reply.partialCopy !== null,
          priorFindings: prior.length,
          dismissedFindings: dismissed.length,
          notes: notes !== null,
          studentResponses: 0,
        };
        const base = { model: `${model} (agent)`, materials, viewedFiles: reply.viewed, agentLog: reply.transcript };
        if (!parsed) {
          // Kept for the supervisor; not retried, a new run would cost as much again.
          record("parse_error", { ...base, rawResponse: `${reply.text}\n\n[agent] ${usage}` });
          return;
        }
        const verified = await verifyFindings(parsed, root);
        mergeSpend(tokens, verified.tokens);
        const trailer = [
          `[agent] ${usage}`,
          `[agent] прочитано: ${reply.viewed.join(", ") || "—"}`,
          ...(reply.partialCopy ? [`[agent] копия неполная: ${reply.partialCopy}`] : []),
          ...verified.dropped.map((d) => `[verify] отброшено: ${d.title} — ${d.reason}`),
        ];
        const analysisId = record("ok", {
          ...base,
          summary: parsed.summary || null,
          rawResponse: `${reply.text}\n\n${trailer.join("\n")}`,
        });
        applyReconciliation(prId, analysisId, verified.result, {
          allowedPriorIds: new Set(prior.map((f) => f.id)),
          reopenableIds: new Set(dismissed.map((f) => f.id)),
          allowNew: true,
          fixesFinal: true,
          wholeRepository: true,
          changed: new Map(),
        });
        // Notes edited meanwhile (by a supervisor or a merged PR) are not overwritten.
        if (parsed.notes && (getProjectNotes(project.id)?.id ?? null) === (notes?.id ?? null)) {
          addProjectNotes(project.id, parsed.notes, { analysisId });
        }
        // The overview is saved: from here on a failure must not repeat it.
        await coverMemory(project, headSha, installationId).catch((error) =>
          console.warn(`[overview] memory of ${project.owner}/${project.repo} not moved:`, error),
        );
        const published = await publishOverviewIssue(project.id, installationId);
        setAnalysisComment(analysisId, published.body);
        done = true;
      },
    );
  } catch (error) {
    if (done) {
      console.warn(`[overview] ${project.owner}/${project.repo}: cleanup after a saved overview failed:`, error);
      return;
    }
    if (error instanceof AgentProcessError) {
      const { provider, model } = agentModel();
      addSpend(tokens, error.spent, provider, model);
    }
    if (tokens.input + tokens.output > 0) {
      record("error", { rawResponse: error instanceof Error ? error.message : String(error), agentLog: failedLog });
    }
    throw error;
  }
}

/**
 * The issue text: how the curator understands the project. Findings stay in the PR comments,
 * so the issue changes only with the notes.
 */
function overviewIssueBody(projectId: number): string {
  const notes = getProjectNotes(projectId);
  const sha = getMemorySha(projectId);
  return [
    "🤖 **AI Curator — как куратор понимает проект**",
    "",
    `Описание составлено по основной ветке${sha ? ` (коммит \`${sha.slice(0, 7)}\`)` : ""}. ` +
      "Куратор опирается на него при разборе pull request; оно обновляется при полном обзоре " +
      "проекта и при правке руководителем.",
    "",
    "**Если здесь что-то неверно, напишите руководителю проекта** — он исправит описание в " +
      "панели куратора. Комментарии в этом issue куратор не читает. Замечания куратора — в " +
      "комментариях к pull request.",
    "",
    "## Как устроен проект",
    "",
    notes?.body ? publicText(notes.body) : "_Описания пока нет._",
    "",
    `_Обновлено ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" }).format(new Date())}_`,
  ].join("\n");
}

/**
 * Create or update the project's overview issue. A failure (no permission, issues disabled) is
 * not thrown: the overview is saved anyway, and the returned body says it was not published.
 */
export async function publishOverviewIssue(
  projectId: number,
  installationId?: number,
): Promise<{ body: string; error: string | null }> {
  const body = overviewIssueBody(projectId);
  const project = getProject(projectId);
  if (!project) return { body, error: "project not found" };
  try {
    const token = await getInstallationToken(installationId ?? (await getRepoInstallationId(project.owner, project.repo)));
    const base = `/repos/${project.owner}/${project.repo}/issues`;
    const existing = getOverviewIssue(projectId);
    if (existing !== null) {
      try {
        await githubRequest(`${base}/${existing}`, {
          method: "PATCH",
          token,
          body: { title: ISSUE_TITLE, body, state: "open" },
        });
        return { body, error: null };
      } catch (error) {
        // A deleted issue is created anew; anything else is a real failure.
        if (!(error instanceof Error && / failed: (404|410) /.test(error.message))) throw error;
      }
    }
    const issue = await githubRequest<{ number: number }>(base, {
      method: "POST",
      token,
      body: { title: ISSUE_TITLE, body },
    });
    setOverviewIssue(projectId, issue.number);
    // Comments go to the supervisor, not here: the curator does not read this issue.
    await githubRequest(`${base}/${issue.number}/lock`, { method: "PUT", token }).catch((error) =>
      console.warn(`[overview] failed to lock issue #${issue.number}:`, error),
    );
    return { body, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[overview] issue of ${project.owner}/${project.repo} not published:`, message);
    return { body: `_Не опубликовано в GitHub: ${message.slice(0, 300)}_\n\n${body}`, error: message };
  }
}
