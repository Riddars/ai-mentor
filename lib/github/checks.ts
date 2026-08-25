import { getInstallationToken } from "@/lib/github/auth";
import { githubRequest } from "@/lib/github/api";

export const CHECK_NAME = "AI Curator";

export type CheckConclusion = "success" | "action_required";

interface CheckOutput {
  title: string;
  summary: string;
}

export async function createCheckRun(params: {
  owner: string;
  repo: string;
  headSha: string;
  installationId: number;
}): Promise<number> {
  const token = await getInstallationToken(params.installationId);
  const data = await githubRequest<{ id: number }>(
    `/repos/${params.owner}/${params.repo}/check-runs`,
    {
      method: "POST",
      token,
      body: {
        name: CHECK_NAME,
        head_sha: params.headSha,
        status: "in_progress",
        started_at: new Date().toISOString(),
      },
    },
  );
  return data.id;
}

export async function concludeCheckRun(params: {
  owner: string;
  repo: string;
  checkRunId: number;
  conclusion: CheckConclusion;
  output: CheckOutput;
  installationId: number;
}): Promise<void> {
  const token = await getInstallationToken(params.installationId);
  await githubRequest(
    `/repos/${params.owner}/${params.repo}/check-runs/${params.checkRunId}`,
    {
      method: "PATCH",
      token,
      body: {
        status: "completed",
        conclusion: params.conclusion,
        completed_at: new Date().toISOString(),
        output: params.output,
      },
    },
  );
}

export async function findCheckRunId(params: {
  owner: string;
  repo: string;
  headSha: string;
  installationId: number;
}): Promise<number | null> {
  const token = await getInstallationToken(params.installationId);
  const data = await githubRequest<{ check_runs: { id: number; name: string }[] }>(
    `/repos/${params.owner}/${params.repo}/commits/${params.headSha}/check-runs`,
    { token },
  );
  const run = data.check_runs.find((c) => c.name === CHECK_NAME);
  return run ? run.id : null;
}
