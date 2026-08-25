import { getConfig } from "@/lib/config";
import { getInstallationToken, getRepoInstallationId } from "@/lib/github/auth";
import { githubRequest } from "@/lib/github/api";
import {
  CheckConclusion,
  concludeCheckRun,
  findCheckRunId,
} from "@/lib/github/checks";
import { postIssueComment } from "@/lib/github/comments";
import { SIMULATED_ANSWER } from "@/lib/curator/simulate";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let config;
  try {
    config = getConfig();
  } catch (error) {
    console.error("[conclude] service not configured:", error);
    return new Response("Service not configured", { status: 500 });
  }

  if (req.headers.get("x-sim-admin-token") !== config.simAdminToken) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { owner, repo, prNumber, conclusion } = await req.json();
  if (!owner || !repo || !prNumber) {
    return new Response("Missing owner, repo or prNumber", { status: 400 });
  }
  const finalConclusion: CheckConclusion = conclusion === "action_required"
    ? "action_required"
    : "success";

  try {
    const installationId = await getRepoInstallationId(owner, repo);
    const token = await getInstallationToken(installationId);
    const pr = await githubRequest<{ head: { sha: string } }>(
      `/repos/${owner}/${repo}/pulls/${prNumber}`,
      { token },
    );
    const checkRunId = await findCheckRunId({
      owner,
      repo,
      headSha: pr.head.sha,
      installationId,
    });
    if (checkRunId === null) {
      return new Response(
        "No AI Curator check run for this PR head; open or reopen the PR first",
        { status: 404 },
      );
    }

    await postIssueComment({
      owner,
      repo,
      issueNumber: prNumber,
      body: SIMULATED_ANSWER,
      installationId,
    });
    await concludeCheckRun({
      owner,
      repo,
      checkRunId,
      conclusion: finalConclusion,
      output: {
        title: "AI Curator (симуляция)",
        summary: "Симулированный разбор завершён вручную.",
      },
      installationId,
    });

    return Response.json({ ok: true, checkRunId, conclusion: finalConclusion });
  } catch (error) {
    console.error("[conclude] failed:", error);
    return new Response("Conclude failed", { status: 500 });
  }
}
