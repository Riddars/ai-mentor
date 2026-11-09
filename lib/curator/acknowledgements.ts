import { getInstallationToken } from "@/lib/github/auth";
import { githubRequest } from "@/lib/github/api";
import { postIssueCommentOnce } from "@/lib/github/comments";
import { getProjectByRepo, isPullRequestAcknowledged, markPullRequestAcknowledged, upsertPullRequest } from "@/lib/curator/store";

type PrState = { state: string; merged: boolean };

export async function acknowledgePullRequest(params: {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
}): Promise<void> {
  const project = getProjectByRepo(params.owner, params.repo);
  if (!project) return;
  const prId = upsertPullRequest(project.id, params.prNumber);
  if (isPullRequestAcknowledged(prId)) return;
  const token = await getInstallationToken(params.installationId);
  const pr = await githubRequest<PrState>(
    `/repos/${params.owner}/${params.repo}/pulls/${params.prNumber}`,
    { token },
  );
  // A late opening event must not tell people to wait in an already merged PR.
  if (pr.state !== "open") return;
  await postIssueCommentOnce({
    ...params,
    issueNumber: params.prNumber,
    key: `pr-${params.prNumber}`,
    body: "ИИ-куратор получил pull request и начал проверку. Рекомендуем дождаться результата перед слиянием. Если PR уже будет слит, ревью появится здесь.",
  });
  markPullRequestAcknowledged(prId);
}

export async function acknowledgeStudentComment(params: {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  commentId: number;
}): Promise<void> {
  const token = await getInstallationToken(params.installationId);
  const pr = await githubRequest<PrState>(
    `/repos/${params.owner}/${params.repo}/pulls/${params.prNumber}`,
    { token },
  );
  if (pr.state !== "open") return;
  await postIssueCommentOnce({
    ...params,
    issueNumber: params.prNumber,
    key: `reply-${params.commentId}`,
    body: `ИИ-куратор получил [ваш комментарий](https://github.com/${params.owner}/${params.repo}/pull/${params.prNumber}#issuecomment-${params.commentId}) и проверит его. Ответ появится в этом PR, даже если его успеют слить.`,
  });
}
