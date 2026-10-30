import { getInstallationToken } from "@/lib/github/auth";
import { githubRequest } from "@/lib/github/api";

export const CHECK_NAME = "AI Curator";

export type CheckConclusion = "success" | "neutral" | "action_required";

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
        output: {
          title: "Куратор проверяет изменения",
          summary:
            "Обычно это занимает 1–3 минуты. Слияние станет доступно после проверки; " +
            "замечания куратора появятся комментарием в pull request.",
        },
      },
    },
  );
  return data.id;
}

export interface CheckRunUpdate {
  owner: string;
  repo: string;
  checkRunId: number;
  conclusion: CheckConclusion;
  output: CheckOutput;
  installationId: number;
}

/**
 * Serialize updates to one check. A late deadline must not replace a completed review with
 * "not reviewed". Keep the last conclusion for the review retry window (24 hours).
 */
export function createCheckRunConcluder(send: (params: CheckRunUpdate) => Promise<void>) {
  const updates = new Map<number, Promise<void>>();
  const completed = new Map<number, CheckConclusion>();
  return (params: CheckRunUpdate): Promise<boolean> => {
    const previous = updates.get(params.checkRunId) ?? Promise.resolve();
    let applied = false;
    const current = previous.catch(() => {}).then(async () => {
      const last = completed.get(params.checkRunId);
      if (params.conclusion === "neutral" && last !== undefined && last !== "neutral") return;
      await send(params);
      completed.set(params.checkRunId, params.conclusion);
      applied = true;
    });
    updates.set(params.checkRunId, current);
    // A check cannot be updated by this process forever; leave a margin beyond retryWindowMs.
    const expiry = setTimeout(() => {
      if (updates.get(params.checkRunId) === current) {
        updates.delete(params.checkRunId);
        completed.delete(params.checkRunId);
      }
    }, 25 * 60 * 60_000);
    expiry.unref();
    return current.then(() => applied);
  };
}

export const concludeCheckRun = createCheckRunConcluder(async (params) => {
  const { owner, repo, checkRunId, conclusion, output, installationId } = params;
  const token = await getInstallationToken(installationId);
  await githubRequest(
    `/repos/${owner}/${repo}/check-runs/${checkRunId}`,
    {
      method: "PATCH",
      token,
      body: {
        status: "completed",
        conclusion,
        completed_at: new Date().toISOString(),
        output,
      },
    },
  );
});

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
