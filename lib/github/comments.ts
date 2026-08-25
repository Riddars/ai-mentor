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
