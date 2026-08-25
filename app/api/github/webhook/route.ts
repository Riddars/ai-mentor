import { getConfig } from "@/lib/config";
import { verifySignature } from "@/lib/github/verify";
import { handlePullRequest } from "@/lib/curator/simulate";

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
  const payload = JSON.parse(rawBody);

  if (event === "pull_request" && RELEVANT_ACTIONS.has(payload.action)) {
    try {
      await handlePullRequest(payload);
    } catch (error) {
      console.error("[webhook] failed to handle pull_request:", error);
      return new Response("Handler error", { status: 500 });
    }
  }

  return Response.json({ ok: true });
}
