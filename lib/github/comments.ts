import { getConfig } from "@/lib/config";
import { getInstallationToken } from "@/lib/github/auth";
import { githubRequest } from "@/lib/github/api";

export async function postIssueComment(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  installationId: number;
}): Promise<void> {
  const token = await getInstallationToken(params.installationId);
  await githubRequest(
    `/repos/${params.owner}/${params.repo}/issues/${params.issueNumber}/comments`,
    { method: "POST", token, body: { body: params.body } },
  );
}

// GitHub is the source of truth after an ambiguous POST (the response can be lost).
// The marker is stable across webhook redelivery and process restarts.
const pending = new Map<string, Promise<void>>();

export async function findIssueComment(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  installationId: number;
  key: string;
}): Promise<string | null> {
  const marker = `<!-- ai-curator-once:${params.key} -->`;
  const token = await getInstallationToken(params.installationId);
  for (let page = 1; ; page++) {
    const comments = await githubRequest<Array<{ body: string | null; user: { type: string } | null; performed_via_github_app?: { id: number } | null }>>(
      `/repos/${params.owner}/${params.repo}/issues/${params.issueNumber}/comments?per_page=100&page=${page}`,
      { token },
    );
    const match = comments.find((comment) => comment.user?.type === "Bot" &&
      String(comment.performed_via_github_app?.id) === getConfig().appId && (comment.body?.includes(marker) ||
        (/^ai-curator-review-\d+-\d+$/.test(params.key) && comment.body?.includes(`<!-- ${params.key} -->`))));
    if (match) return match.body;
    if (comments.length < 100) return null;
  }
}

export async function issueCommentExists(params: Parameters<typeof findIssueComment>[0]): Promise<boolean> {
  return (await findIssueComment(params)) !== null;
}

export async function postIssueCommentOnce(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  installationId: number;
  key: string;
  body: string;
}): Promise<void> {
  const marker = `<!-- ai-curator-once:${params.key} -->`;
  const lock = `${params.owner}/${params.repo}#${params.issueNumber}:${params.key}`;
  const existing = pending.get(lock);
  if (existing) return existing;
  const task = (async () => {
    if (await issueCommentExists(params)) return;
    await postIssueComment({ ...params, body: `${params.body}\n\n${marker}` });
  })();
  pending.set(lock, task);
  try {
    await task;
  } finally {
    if (pending.get(lock) === task) pending.delete(lock);
  }
}
