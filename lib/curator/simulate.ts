import { getConfig } from "@/lib/config";
import { CheckConclusion, concludeCheckRun, createCheckRun } from "@/lib/github/checks";
import { postIssueComment } from "@/lib/github/comments";
import { handleProvodPullRequest } from "@/lib/curator/provod-review";

export const SIMULATED_ANSWER =
  "🤖 **AI Curator (симуляция)**\n\n" +
  "Это заглушка вместо ответа языковой модели — обращения к Anthropic API " +
  "на этом этапе нет. Сообщение подтверждает, что связка GitHub → сервис → " +
  "проверка → комментарий работает end-to-end.";

interface PullRequestPayload {
  action: string;
  installation?: { id: number };
  repository: { name: string; owner: { login: string } };
  pull_request: { number: number; head: { sha: string } };
}

export async function handlePullRequest(
  payload: PullRequestPayload,
): Promise<void> {
  const { reviewer, simMode, simDelayMs } = getConfig();
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const headSha = payload.pull_request.head.sha;
  const prNumber = payload.pull_request.number;
  const installationId = payload.installation?.id;

  if (installationId === undefined) {
    throw new Error("Webhook payload has no installation id");
  }

  if (reviewer === "provod") {
    await handleProvodPullRequest({ owner, repo, prNumber, headSha, installationId });
    return;
  }

  if (simMode === "offline") {
    console.log(`[curator] offline mode: ignoring PR #${prNumber} in ${owner}/${repo}`);
    return;
  }

  const checkRunId = await createCheckRun({ owner, repo, headSha, installationId });

  if (simMode === "manual") {
    return;
  }

  const conclusion: CheckConclusion = simMode === "auto-block"
    ? "action_required"
    : "success";

  setTimeout(() => {
    void completeReview({ owner, repo, prNumber, checkRunId, conclusion, installationId });
  }, simDelayMs);
}

async function completeReview(params: {
  owner: string;
  repo: string;
  prNumber: number;
  checkRunId: number;
  conclusion: CheckConclusion;
  installationId: number;
}): Promise<void> {
  try {
    await postIssueComment({
      owner: params.owner,
      repo: params.repo,
      issueNumber: params.prNumber,
      body: SIMULATED_ANSWER,
      installationId: params.installationId,
    });
    await concludeCheckRun({
      owner: params.owner,
      repo: params.repo,
      checkRunId: params.checkRunId,
      conclusion: params.conclusion,
      output: {
        title: "AI Curator (симуляция)",
        summary: "Симулированный разбор завершён.",
      },
      installationId: params.installationId,
    });
  } catch (error) {
    console.error("[curator] failed to complete simulated review:", error);
  }
}
