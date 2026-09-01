import { getConfig } from "@/lib/config";
import { verifySignature } from "@/lib/github/verify";
import { handlePullRequest } from "@/lib/curator/simulate";
import { handleStudentComment } from "@/lib/curator/review";
import { recordEventOnce } from "@/lib/curator/store";

export const runtime = "nodejs";

const RELEVANT_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

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
  if (config.reviewer === "llm" && deliveryId) {
    const isNew = recordEventOnce(deliveryId, event, payload.action ?? null);
    if (!isNew) {
      return Response.json({ ok: true, duplicate: true });
    }
  }

  if (event === "pull_request" && RELEVANT_ACTIONS.has(payload.action)) {
    try {
      await handlePullRequest(payload);
    } catch (error) {
      console.error("[webhook] failed to handle pull_request:", error);
      return new Response("Handler error", { status: 500 });
    }
  } else if (
    event === "issue_comment" &&
    config.reviewer === "llm" &&
    payload.action === "created" &&
    payload.issue?.pull_request &&
    payload.sender?.type !== "Bot" &&
    payload.installation?.id !== undefined
  ) {
    // Ответ студента без нового коммита: сверка по объяснению в фоне (без check-run).
    void handleStudentComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
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
