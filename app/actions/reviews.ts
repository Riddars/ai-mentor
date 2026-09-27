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
  if (!project || !pr.headSha) return { error: "Нет данных о последнем коммите." };

  if (!bringCommitJobForward(pr.id)) {
    try {
      const installationId = await getRepoInstallationId(project.owner, project.repo);
      await startCommitReview(
        {
          owner: project.owner,
          repo: project.repo,
          prNumber: pr.number,
          headSha: pr.headSha,
          installationId,
          author: pr.author,
          title: pr.title,
        },
        { delay: false, force: true },
      );
    } catch (error) {
      console.error("[panel] restart review failed:", error);
      return { error: "Не удалось связаться с GitHub." };
    }
  }
  revalidatePath(`/projects/${pr.projectId}`);
  return { ok: "Разбор поставлен в очередь." };
}
