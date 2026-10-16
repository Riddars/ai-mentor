"use server";

import { revalidatePath } from "next/cache";
import { getRepoInstallationId } from "@/lib/github/auth";
import { startCommitReview } from "@/lib/curator/review";
import { publishOverviewIssue, startOverview } from "@/lib/curator/overview";
import {
  addProjectNotes,
  bringCommitJobForward,
  getOverviewIssue,
  getProject,
  getProjectNotes,
  getPullRequest,
  isSupervisorOf,
  NOTES_MAX_CHARS,
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
      : { ok: "Последний коммит уже разобран или разбор уже идёт." };
  } catch (error) {
    console.error("[panel] restart review failed:", error);
    return { error: "Не удалось связаться с GitHub." };
  }
}

/** The head or a supervisor of the project; null when the viewer may not manage it. */
async function projectManager(projectId: number): Promise<{ login: string } | null> {
  const viewer = await getViewer();
  if (!viewer || !getProject(projectId)) return null;
  if (viewer.role !== "head" && !isSupervisorOf(viewer.userId, projectId)) return null;
  return viewer;
}

/** Queue a full overview of the project now. */
export async function startOverviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const projectId = Number(formData.get("projectId"));
  if (!(await projectManager(projectId))) return { error: "Нет доступа к этому проекту." };
  const result = startOverview(projectId, "manual");
  revalidatePath(`/projects/${projectId}`);
  if (result === "unavailable") return { error: "Обзор недоступен: не настроены разбор моделью или агент." };
  return result === "queued"
    ? { ok: "Полный обзор поставлен в очередь." }
    : { ok: "Полный обзор уже в очереди или идёт." };
}

/** Save the supervisor's edit of the notes about the project and update the overview issue. */
export async function saveProjectNotesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const projectId = Number(formData.get("projectId"));
  const viewer = await projectManager(projectId);
  if (!viewer) return { error: "Нет доступа к этому проекту." };
  const body = String(formData.get("notes") ?? "").trim();
  if (body.length > NOTES_MAX_CHARS) return { error: `Не длиннее ${NOTES_MAX_CHARS} знаков.` };
  // An unchanged text is not a new version: it would void the notes proposed by open PRs.
  if (body === (getProjectNotes(projectId)?.body ?? "")) return { ok: "Без изменений." };
  addProjectNotes(projectId, body, { actor: viewer.login });
  revalidatePath(`/projects/${projectId}`);
  // The issue shows the notes only once an overview has created it.
  if (getOverviewIssue(projectId) === null) return { ok: "Сохранено." };
  const published = await publishOverviewIssue(projectId);
  return published.error
    ? { ok: "Сохранено, но issue в GitHub обновить не удалось." }
    : { ok: "Сохранено, issue в GitHub обновлён." };
}
