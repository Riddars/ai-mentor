import { githubRequest } from "@/lib/github/api";
import { getInstallationToken } from "@/lib/github/auth";
import { getMemorySha, setMemorySha } from "@/lib/curator/store";

// The project memory follows the main branch: `memory_sha` is the commit its findings and notes
// describe. A project overview sets it; a PR merged into the main branch moves it to the merge
// commit. When the main branch moves past it in another way (changes merged while the service
// was down, a database restored from an old copy, rewritten history), the memory has a gap and
// the project needs a new overview.

interface Project {
  id: number;
  owner: string;
  repo: string;
}

type CompareStatus = "ahead" | "behind" | "identical" | "diverged";

/** Files whose changes do not call for a new overview. */
const DOCS_ONLY = /\.(md|rst)$/i;

/** Latest commit of the repository's default branch. */
export async function defaultBranchHead(project: Project, installationId: number): Promise<string> {
  const token = await getInstallationToken(installationId);
  const repo = await githubRequest<{ default_branch: string }>(`/repos/${project.owner}/${project.repo}`, { token });
  const branch = await githubRequest<{ commit: { sha: string } }>(
    `/repos/${project.owner}/${project.repo}/branches/${encodeURIComponent(repo.default_branch)}`,
    { token },
  );
  return branch.commit.sha;
}

/** How `head` relates to `base`; null when GitHub does not know `base` (rewritten history). */
async function compare(
  project: Project,
  base: string,
  head: string,
  installationId: number,
): Promise<{ status: CompareStatus; files: string[]; filesComplete: boolean } | null> {
  const token = await getInstallationToken(installationId);
  try {
    const data = await githubRequest<{ status: CompareStatus; files?: Array<{ filename: string }> }>(
      `/repos/${project.owner}/${project.repo}/compare/${base}...${head}`,
      { token },
    );
    const files = (data.files ?? []).map((f) => f.filename);
    // GitHub lists at most 300 files of a comparison.
    return { status: data.status, files, filesComplete: files.length < 300 };
  } catch (error) {
    if (error instanceof Error && / failed: (404|422) /.test(error.message)) return null;
    throw error;
  }
}

/**
 * Move the memory to `sha` unless it already covers a newer commit. The memory may move while
 * GitHub is asked (another merge, an overview): then it is compared again.
 */
async function moveMemoryForward(
  project: Project,
  sha: string,
  installationId: number,
  fromNothing: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = getMemorySha(project.id);
    if (current === sha || (!current && !fromNothing)) return;
    if (current) {
      const result = await compare(project, current, sha, installationId).catch(() => null);
      // A merge moves it only forward; an overview also replaces a memory of rewritten history.
      const forward = result?.status === "ahead" || (fromNothing && result?.status !== "behind");
      if (!forward) return;
    }
    if (setMemorySha(project.id, sha, current)) return;
  }
}

/** A PR was merged into the main branch: the memory moves to its merge commit if that is newer. */
export async function advanceMemory(project: Project, mergeSha: string, installationId: number): Promise<void> {
  // No overview yet: the memory gap check starts one.
  await moveMemoryForward(project, mergeSha, installationId, false);
}

/** An overview of `sha` is done: the memory covers it, unless a merge meanwhile moved it further. */
export async function coverMemory(project: Project, sha: string, installationId: number): Promise<void> {
  await moveMemoryForward(project, sha, installationId, true);
}

/**
 * Whether the main branch has changes the memory does not cover. Changes of documents only
 * are not a gap: the memory just moves on.
 */
export async function memoryGap(
  project: Project,
  installationId: number,
): Promise<{ gap: boolean; head: string; initial: boolean }> {
  const head = await defaultBranchHead(project, installationId);
  const current = getMemorySha(project.id);
  if (!current) return { gap: true, head, initial: true };
  if (current === head) return { gap: false, head, initial: false };
  const result = await compare(project, current, head, installationId);
  if (!result || result.status === "diverged") return { gap: true, head, initial: false };
  if (result.status !== "ahead") return { gap: false, head, initial: false };
  if (result.filesComplete && result.files.every((f) => DOCS_ONLY.test(f))) {
    setMemorySha(project.id, head, current);
    return { gap: false, head, initial: false };
  }
  return { gap: true, head, initial: false };
}
