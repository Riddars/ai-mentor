import { CHECK_NAME } from "@/lib/github/checks";
import { githubRequest } from "@/lib/github/api";
import { getInstallationToken, getRepoInstallationId } from "@/lib/github/auth";

/** Importable protection of the default branch, without gating on AI review. */
export function rulesetJson(): string {
  return JSON.stringify({
    name: "main-protection",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "pull_request", parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      } },
    ],
  }, null, 2);
}

export interface RepositorySetup {
  installed: boolean;
  /** null when it could not be read (the app is not installed). */
  isPublic: boolean | null;
  /** Effective PR rule; null for private repos whose rules are not queried. */
  pullRequestsOnly: boolean | null;
  /** The `AI Curator` check is required on the main branch and only the app can set it. */
  checkRequired: boolean | null;
  /** Logins of outside collaborators (students) who accepted their invitation; null when unknown. */
  students: string[] | null;
}

interface BranchRule {
  type: string;
  parameters?: { required_status_checks?: Array<{ context: string; integration_id?: number }> };
}

/** Read how the repository is set up; throws only when GitHub cannot be reached. */
export async function checkRepositorySetup(owner: string, repo: string, appId: string): Promise<RepositorySetup> {
  let installationId: number;
  try {
    installationId = await getRepoInstallationId(owner, repo);
  } catch (error) {
    if (error instanceof Error && / failed: 404 /.test(error.message)) {
      return { installed: false, isPublic: null, pullRequestsOnly: null, checkRequired: null, students: null };
    }
    throw error;
  }
  const token = await getInstallationToken(installationId);
  const info = await githubRequest<{ private: boolean; default_branch: string }>(`/repos/${owner}/${repo}`, { token });
  const rules = info.private ? [] : await githubRequest<BranchRule[]>(
    `/repos/${owner}/${repo}/rules/branches/${encodeURIComponent(info.default_branch)}`,
    { token },
  ).catch((error: unknown) => {
    if (error instanceof Error && / failed: 404 /.test(error.message)) return [];
    throw error;
  });
  const students = await githubRequest<Array<{ login: string }>>(
    `/repos/${owner}/${repo}/collaborators?affiliation=outside&per_page=100`,
    { token },
  ).then(
    (list) => list.map((c) => c.login),
    () => null,
  );
  return {
    installed: true,
    isPublic: !info.private,
    pullRequestsOnly: info.private ? null : rules.some((r) => r.type === "pull_request"),
    checkRequired: rules.some(
      (r) =>
        r.type === "required_status_checks" &&
        (r.parameters?.required_status_checks ?? []).some(
          (c) => c.context === CHECK_NAME && String(c.integration_id) === appId,
        ),
    ),
    students,
  };
}
