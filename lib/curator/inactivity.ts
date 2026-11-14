import { githubRequest } from "@/lib/github/api";
import { getInstallationToken, getRepoInstallationId } from "@/lib/github/auth";
import { postIssueCommentOnce } from "@/lib/github/comments";
import { cancelPauseNotice, delayPauseNotice, completeActivityCheck, finishPauseNotice, getProject, listAllProjects, pauseNoticeSent,
  pendingPauseNotices, projectActivity, queuePauseNotice } from "@/lib/curator/store";

export const PAUSE_MESSAGE = "Проект на паузе. AI Куратор не выполняет разборы. Обратитесь к руководителю проекта, чтобы возобновить проверку.";

export function activityDate(value: string): number {
  return Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
}

/** Calendar months, clamped to the last day of the destination month. */
export function inactivityCutoff(now: Date): Date {
  const cutoff = new Date(now);
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 2);
  const end = new Date(cutoff);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  cutoff.setUTCDate(Math.min(day, end.getUTCDate()));
  return cutoff;
}

type Actor = { type: string; login: string };
type TimelineEvent = { created_at?: string; submitted_at?: string; updated_at?: string; actor?: Actor | null; user?: Actor | null };
type Issue = { number: number; created_at: string; updated_at: string; user: Actor | null };
type Repo = { pushed_at: string | null; updated_at: string; created_at: string };

// Exhaust every page or fail closed: incomplete history must never cause a pause.
async function pages<T>(path: string, token: string, progress = () => {}): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await githubRequest<T[]>(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, { token });
    progress();
    result.push(...batch);
    if (batch.length < 100) return result;
  }
  throw new Error("Activity history exceeds safe scan limit; project left active");
}

export async function checkInactiveProjects(now = new Date(), progress = () => {}): Promise<void> {
  const cutoff = inactivityCutoff(now);
  for (const project of listAllProjects()) {
    progress();
    if (project.status !== "active") continue;
    const state = projectActivity(project.id);
    if (!state || !Number.isFinite(activityDate(state.at))) continue;
    if (state.checkedAt && now.getTime() - activityDate(state.checkedAt) < 86_400_000) continue;
    // New connections/resumes receive a full two months, even for an old repository.
    if (activityDate(state.at) >= cutoff.getTime()) continue;
    try {
      const installationId = await getRepoInstallationId(project.owner, project.repo);
      const token = await getInstallationToken(installationId);
      const base = `/repos/${project.owner}/${project.repo}`;
      const before = await githubRequest<Repo>(base, { token });
      let latest = Math.max(activityDate(state.at), activityDate(before.created_at));
      if (before.pushed_at) latest = Math.max(latest, activityDate(before.pushed_at));
      if (!Number.isFinite(latest)) throw new Error("Invalid repository activity date");
      if (latest < cutoff.getTime()) {
        const commentDates = new Map<number, number>();
        for (const path of ["issues/comments", "pulls/comments"]) {
          if (latest >= cutoff.getTime()) break;
          for (const comment of await pages<{updated_at: string; user: Actor; issue_url?: string; pull_request_url?: string}>(`${base}/${path}?since=${encodeURIComponent(cutoff.toISOString())}`, token, progress)) {
            const issueNumber = Number((comment.issue_url ?? comment.pull_request_url)?.split("/").pop());
            if (issueNumber) commentDates.set(issueNumber, Math.max(commentDates.get(issueNumber) ?? 0, activityDate(comment.updated_at)));
            if (comment.user.type !== "Bot") latest = Math.max(latest, activityDate(comment.updated_at));
          }
        }
        const issues = latest >= cutoff.getTime() ? [] : await pages<Issue>(`${base}/issues?state=all&sort=updated&direction=desc&since=${encodeURIComponent(cutoff.toISOString())}`, token, progress);
        for (const issue of issues) {
          if (latest >= cutoff.getTime()) break;
          progress();
          let explainedAt = Math.max(activityDate(issue.created_at), commentDates.get(issue.number) ?? 0);
          if (issue.user?.type !== "Bot") latest = Math.max(latest, activityDate(issue.created_at));
          if (latest >= cutoff.getTime()) break;
          for (const event of await pages<TimelineEvent>(`${base}/issues/${issue.number}/timeline`, token, progress)) {
            const actor = event.actor ?? event.user;
            const date = event.updated_at ?? event.created_at ?? event.submitted_at;
            if (date) explainedAt = Math.max(explainedAt, activityDate(date));
            if (date && actor?.type !== "Bot") latest = Math.max(latest, activityDate(date));
          }
          // Body edits may have no timeline event. Never infer inactivity from missing evidence.
          if (activityDate(issue.updated_at) > explainedAt) latest = Math.max(latest, activityDate(issue.updated_at));
        }
      }
      if (!Number.isFinite(latest)) throw new Error("Invalid timeline date");
      // A concurrent GitHub change or webhook invalidates the inactivity decision.
      const after = await githubRequest<Repo>(base, { token });
      if (before.pushed_at !== after.pushed_at || before.updated_at !== after.updated_at) continue;
      completeActivityCheck(project.id, state.revision, new Date(latest).toISOString(), cutoff.toISOString(), now.toISOString());
    } catch (error) {
      console.warn(`[activity] ${project.owner}/${project.repo} left active:`, error);
    }
  }
}

export async function notifyPausedPullRequest(params: { projectId: number; number: number; installationId: number }): Promise<void> {
  queuePauseNotice(params.projectId, params.number);
  if (pauseNoticeSent(params.projectId, params.number)) return;
  const project = getProject(params.projectId);
  if (!project || project.status !== "paused") return;
  const token = await getInstallationToken(params.installationId);
  const pr = await githubRequest<{ state: string }>(`/repos/${project.owner}/${project.repo}/pulls/${params.number}`, { token });
  if (pr.state !== "open") { cancelPauseNotice(project.id, params.number); return; }
  // Recheck after the await, in case the supervisor resumed the project.
  if (getProject(project.id)?.status !== "paused") return;
  const sent = await postIssueCommentOnce({ ...project, issueNumber: params.number, installationId: params.installationId,
    key: `paused-pr-${params.number}`, body: PAUSE_MESSAGE,
    shouldPost: () => getProject(project.id)?.status === "paused" });
  if (sent) finishPauseNotice(project.id, params.number);
  else cancelPauseNotice(project.id, params.number);
}

export async function retryPauseNotifications(): Promise<void> {
  for (const row of pendingPauseNotices()) {
    const project = getProject(row.projectId);
    if (!project || project.status !== "paused") { cancelPauseNotice(row.projectId, row.number); continue; }
    try {
      await notifyPausedPullRequest({ ...row, installationId: await getRepoInstallationId(project.owner, project.repo) });
    } catch (error) { delayPauseNotice(row.projectId, row.number); console.warn("[activity] pause notice will retry:", error); }
  }
}
