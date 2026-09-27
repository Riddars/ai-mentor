import { getInstallationToken } from "@/lib/github/auth";
import { githubRequest } from "@/lib/github/api";

// Who counts as a project member: only their PRs are reviewed and only their comments are
// taken as student replies (repositories are public, anyone could comment). The
// `author_association` of an event is a fast path only: members of an organisation with a
// private membership (the default) show up there as outsiders, so otherwise the member's
// permission on the repository is asked from GitHub.

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const MEMBER_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const CACHE_MS = 10 * 60_000;

const cache = new Map<string, { member: boolean; expiresAt: number }>();

export async function isProjectMember(params: {
  owner: string;
  repo: string;
  login: string | null | undefined;
  association: string | null | undefined;
  installationId: number;
}): Promise<boolean> {
  if (params.association && TRUSTED_ASSOCIATIONS.has(params.association)) return true;
  if (!params.login) return false;

  const key = `${params.owner}/${params.repo}/${params.login}`.toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.member;

  const token = await getInstallationToken(params.installationId);
  const data = await githubRequest<{ permission: string }>(
    `/repos/${params.owner}/${params.repo}/collaborators/${encodeURIComponent(params.login)}/permission`,
    { token },
  );
  const member = MEMBER_PERMISSIONS.has(data.permission);
  cache.set(key, { member, expiresAt: Date.now() + CACHE_MS });
  return member;
}
