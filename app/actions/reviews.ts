"use server";

import { revalidatePath } from "next/cache";
import { getRepoInstallationId } from "@/lib/github/auth";
import { startCommitReview } from "@/lib/curator/review";
import {
  bringCommitJobForward,
  getProject,
  getPullRequest,
  isSupervisorOf,
} from "@/lib/curator/store";
import { getViewer } from "@/lib/users";
import type { ActionState } from "@/app/actions/admin";

/** Restart the review of a PR's latest commit (a supervisor of the project or the head). */
export async function restartReviewAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const viewer = await getViewer();
  if (!viewer) return { error: "Требуется вход." };

  const pr = getPullRequest(Number(formData.get("prId")));
  if (!pr) return { error: "Pull request не найден." };
  if (viewer.role !== "head" && !isSupervisorOf(viewer.userId, pr.projectId)) {
    return { error: "Нет доступа к этому проекту." };
  }
  const project = getProject(pr.projectId);
  if (!project) return { error: "Проект не найден." };
  if (pr.state !== null && pr.state !== "open") return { error: "Pull request уже закрыт." };

  // A job already waiting (backoff or daily limit) runs at once; the limit still applies.
  if (bringCommitJobForward(pr.id)) {
    revalidatePath(`/projects/${pr.projectId}`);
    return { ok: "Разбор выполнится в течение минуты, если не исчерпан дневной лимит." };
  }
  try {
    const installationId = await getRepoInstallationId(project.owner, project.repo);
    const result = await startCommitReview(
      {
        owner: project.owner,
        repo: project.repo,
        prNumber: pr.number,
        headSha: pr.headSha ?? "",
        installationId,
        author: pr.author,
        title: pr.title,
      },
      "restart",
    );
    revalidatePath(`/projects/${pr.projectId}`);
    return result === "queued"
      ? { ok: "Разбор поставлен в очередь." }
      : { ok: "Разбор этого коммита уже выполняется или pull request закрыт." };
  } catch (error) {
    console.error("[panel] restart review failed:", error);
    return { error: "Не удалось связаться с GitHub." };
  }
}
