import { githubRequest } from "@/lib/github/api";
import { getInstallationToken } from "@/lib/github/auth";
import { concludeCheckRun, createCheckRun } from "@/lib/github/checks";
import { postIssueComment } from "@/lib/github/comments";
import { chat } from "@/lib/llm/chat";

/** Общие координаты pull request, которые нужны на каждом шаге разбора. */
export interface ReviewParams {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  installationId: number;
}

// Потолок на суммарный объём патчей в промпте: страховка от разового гигантского
// PR, а не тонкая настройка. Крупнее — обрезаем и честно помечаем это в тексте.
const MAX_PATCH_CHARS = 50_000;

interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

const SYSTEM_PROMPT = `Ты — ИИ-куратор студенческих исследований на стыке химии и машинного обучения.
Ты разбираешь изменения из pull request в контексте исследовательской задачи проекта.

Ищи существенные методические и содержательные ошибки, способные повлиять на выводы работы:
утечка данных между обучающей и тестовой выборками, некорректное разделение данных,
дубликаты в датасете, неподходящая метрика, невоспроизводимость эксперимента, расхождение
между описанием проекта и фактической реализацией, ошибки в коде, меняющие результат без
явного сбоя.

Правила:
- Каждую находку подтверждай конкретным фрагментом кода или данных из изменений. Находку без
  подтверждения не включай.
- Для каждой находки укажи: в чём проблема, чем она грозит результатам, где обнаружена, как
  проверить или исправить. Тон наставнический — объясняй, но не переписывай код за студента.
- Если существенных проблем нет — скажи об этом коротко, без выдумывания замечаний.
- Отвечай на русском языке, кратким Markdown. Решение по каждой находке остаётся за студентом.`;

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

/** Собрать контекст, спросить модель и вернуть готовый комментарий для PR. */
export async function runReview(params: ReviewParams): Promise<string> {
  const [files, research] = await Promise.all([
    fetchChangedFiles(params),
    fetchResearchDoc(params),
  ]);

  const researchBlock = research
    ? `Описание исследования (RESEARCH.md):\n${research}\n\n`
    : "Описание исследования (RESEARCH.md) в репозитории не найдено.\n\n";

  const userPrompt =
    researchBlock +
    `Изменения в pull request #${params.prNumber}:\n\n${buildChangesText(files)}`;

  const answer = await chat([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ]);

  return `🤖 **AI Curator**\n\n${answer}`;
}

/**
 * Точка входа разбора языковой моделью для webhook-обработчика. Обязательную
 * проверку ставим сразу (она блокирует слияние), а сам разбор запускаем в фоне,
 * чтобы не держать ответ на вебхук на время обращения к модели.
 */
export async function handleLlmPullRequest(params: ReviewParams): Promise<void> {
  const checkRunId = await createCheckRun({
    owner: params.owner,
    repo: params.repo,
    headSha: params.headSha,
    installationId: params.installationId,
  });
  void completeReview(params, checkRunId);
}

async function completeReview(
  params: ReviewParams,
  checkRunId: number,
): Promise<void> {
  try {
    const comment = await runReview(params);
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
    // Отсутствие ответа не должно превращаться в разрешение: оставляем слияние
    // заблокированным (action_required) и сообщаем об этом в pull request.
    try {
      await postIssueComment({
        owner: params.owner,
        repo: params.repo,
        issueNumber: params.prNumber,
        body:
          "🤖 **AI Curator**\n\nНе удалось выполнить разбор изменений: сервис анализа " +
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
