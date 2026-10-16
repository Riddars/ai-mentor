import { CHECK_NAME } from "@/lib/github/checks";
import { githubRequest } from "@/lib/github/api";
import { getInstallationToken, getRepoInstallationId } from "@/lib/github/auth";

// What a project repository needs on GitHub for the curator to work: the app installed, a
// public repository (required checks of the free plan work only there) and a ruleset on the
// main branch — changes only through pull requests, the `AI Curator` check required and bound
// to the app. The ruleset is imported by a person (Settings → Rules → Rulesets → Import); the
// app only reads it, with no rights beyond Metadata: read.

/** The ruleset file people import into a project repository. */
export function rulesetJson(appId: string): string {
  return JSON.stringify(
    {
      name: "main-protection",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      bypass_actors: [],
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [{ context: CHECK_NAME, integration_id: Number(appId) }],
          },
        },
      ],
    },
    null,
    2,
  );
}

export interface RepositorySetup {
  installed: boolean;
  /** null when it could not be read (the app is not installed). */
  isPublic: boolean | null;
  /** Changes to the main branch go only through pull requests. */
  pullRequestsOnly: boolean | null;
  /** The `AI Curator` check is required on the main branch and only the app can set it. */
  checkRequired: boolean | null;
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
      return { installed: false, isPublic: null, pullRequestsOnly: null, checkRequired: null };
    }
    throw error;
  }
  const token = await getInstallationToken(installationId);
  const info = await githubRequest<{ private: boolean; default_branch: string }>(`/repos/${owner}/${repo}`, { token });
  const rules = await githubRequest<BranchRule[]>(
    `/repos/${owner}/${repo}/rules/branches/${encodeURIComponent(info.default_branch)}`,
    { token },
  );
  return {
    installed: true,
    isPublic: !info.private,
    pullRequestsOnly: rules.some((r) => r.type === "pull_request"),
    checkRequired: rules.some(
      (r) =>
        r.type === "required_status_checks" &&
        (r.parameters?.required_status_checks ?? []).some(
          (c) => c.context === CHECK_NAME && String(c.integration_id) === appId,
        ),
    ),
  };
}
