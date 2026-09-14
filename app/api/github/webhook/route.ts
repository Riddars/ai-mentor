import { getConfig } from "@/lib/config";
import { verifySignature } from "@/lib/github/verify";
import { concludeCheckRun, createCheckRun } from "@/lib/github/checks";
import { handlePullRequest } from "@/lib/curator/simulate";
import { handleStudentComment } from "@/lib/curator/review";
import {
  forgetEvent,
  getProjectByRepo,
  recordEventOnce,
  upsertPullRequest,
} from "@/lib/curator/store";

export const runtime = "nodejs";

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export async function POST(req: Request) {
  const rawBody = await req.text();

  let config;
  try {
    config = getConfig();
  } catch (error) {
    console.error("[webhook] service not configured:", error);
    return new Response("Service not configured", { status: 500 });
  }

  const signature = req.headers.get("x-hub-signature-256");
  if (!verifySignature(rawBody, signature, config.webhookSecret)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  const deliveryId = req.headers.get("x-github-delivery");
  const payload = JSON.parse(rawBody);

  // Идемпотентность на входе: память ведёт только llm-ревьюер, поэтому и дедуп
  // доставок держим там же. Повторную доставку того же события молча пропускаем.
  const dedup = config.reviewer === "llm" && deliveryId ? deliveryId : null;
  if (dedup) {
    const isNew = recordEventOnce(dedup, event, payload.action ?? null);
    if (!isNew) {
      return Response.json({ ok: true, duplicate: true });
    }
  }
  // A 500 asks GitHub to redeliver; forget the delivery so the retry is not a duplicate.
  const failed = (message: string, error: unknown) => {
    console.error(`[webhook] ${message}:`, error);
    if (dedup) forgetEvent(dedup);
    return new Response("Handler error", { status: 500 });
  };

  const isPullRequest = event === "pull_request";
  const isComment = event === "issue_comment";
  if (!isPullRequest && !isComment) {
    return Response.json({ ok: true });
  }

  // Ворота подключения: разбираются только проекты, подключённые в управлении.
  // Незнакомый репозиторий игнорируем целиком (без check-run — защита ветки для
  // него не настраивается). См. принятые решения.md.
  const owner: string | undefined = payload.repository?.owner?.login;
  const repo: string | undefined = payload.repository?.name;
  const project = owner && repo ? getProjectByRepo(owner, repo) : null;
  if (!project) {
    return Response.json({ ok: true, ignored: "not connected" });
  }

  if (isPullRequest && payload.action === "closed") {
    // Состояние PR нужно панели (слит / закрыт без слияния); разбора здесь нет.
    upsertPullRequest(project.id, payload.pull_request.number, {
      author: payload.pull_request.user?.login ?? null,
      title: payload.pull_request.title ?? null,
      state: payload.pull_request.merged ? "merged" : "closed",
    });
    return Response.json({ ok: true, closed: true });
  }

  if (isPullRequest && REVIEW_ACTIONS.has(payload.action)) {
    // opened / synchronize / reopened all mean the PR is open — record it in both
    // reviewer modes so a reopened PR does not stay "closed" in memory.
    upsertPullRequest(project.id, payload.pull_request.number, {
      author: payload.pull_request.user?.login ?? null,
      title: payload.pull_request.title ?? null,
      state: "open",
    });
  }

  if (project.status === "paused") {
    // Пауза отключает разбор. Чтобы она не блокировала слияние, обязательная
    // проверка завершается успехом с пояснением; комментарий не публикуем.
    if (isPullRequest && REVIEW_ACTIONS.has(payload.action) && payload.installation?.id !== undefined) {
      try {
        const args = {
          owner: project.owner,
          repo: project.repo,
          installationId: payload.installation.id as number,
        };
        const checkRunId = await createCheckRun({ ...args, headSha: payload.pull_request.head.sha });
        await concludeCheckRun({
          ...args,
          checkRunId,
          conclusion: "success",
          output: { title: "AI Curator", summary: "Проект на паузе — разбор не выполняется." },
        });
      } catch (error) {
        return failed("failed to conclude paused check", error);
      }
    }
    return Response.json({ ok: true, ignored: "paused" });
  }

  if (isPullRequest && REVIEW_ACTIONS.has(payload.action)) {
    try {
      await handlePullRequest(payload);
    } catch (error) {
      return failed("failed to handle pull_request", error);
    }
  } else if (
    isComment &&
    config.reviewer === "llm" &&
    payload.action === "created" &&
    payload.issue?.pull_request &&
    payload.sender?.type !== "Bot" &&
    payload.installation?.id !== undefined
  ) {
    // Ответ студента без нового коммита: сверка по объяснению в фоне (без check-run).
    void handleStudentComment({
      owner: project.owner,
      repo: project.repo,
      prNumber: payload.issue.number,
      installationId: payload.installation.id,
      commentId: payload.comment.id,
      commentBody: payload.comment.body ?? "",
      commenterLogin: payload.comment.user?.login ?? null,
    }).catch((error) => {
      console.error("[webhook] failed to handle issue_comment:", error);
    });
  }

  return Response.json({ ok: true });
}
