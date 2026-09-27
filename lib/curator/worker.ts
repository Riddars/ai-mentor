import { backupDatabase } from "@/lib/db";
import { parseDbDate } from "@/lib/format";
import { getConfig } from "@/lib/config";
import { githubRequest } from "@/lib/github/api";
import { getInstallationToken, getRepoInstallationId } from "@/lib/github/auth";
import { isProjectMember } from "@/lib/github/members";
import {
  concludeCheck,
  executeCommentJob,
  executeCommitJob,
  queueSettings,
  reportReviewFailure,
  StaleReviewError,
  startCommitReview,
  type CommentReviewParams,
  type ReviewParams,
} from "@/lib/curator/review";
import {
  finishJob,
  getProject,
  listAllProjects,
  listDueJobs,
  listOverdueJobs,
  markCheckConcluded,
  markJobRunning,
  recentAnalysesOfProject,
  requeueRunningJobs,
  requeueStrayRunningJobs,
  rescheduleJob,
  type ReviewJob,
} from "@/lib/curator/store";

// Review queue worker. Runs inside the app process (started from instrumentation.ts): a
// tick every few seconds concludes overdue checks, starts due jobs and, less often,
// re-syncs open PRs with GitHub and backs up the database. The side effects are passed
// in as `WorkerDeps` so the queue logic can be exercised without GitHub or a model.

const TICK_MS = 15_000;
const SWEEP_MS = 10 * 60_000;

export interface WorkerDeps {
  runCommit(job: ReviewJob): Promise<void>;
  runComment(job: ReviewJob): Promise<void>;
  concludeUnreviewed(job: ReviewJob, summary: string): Promise<void>;
  reportFailure(job: ReviewJob): Promise<void>;
}

const realDeps: WorkerDeps = {
  runCommit: (job) =>
    executeCommitJob(job.payload as ReviewParams, job.prId, job.id),
  runComment: (job) => executeCommentJob(job.payload as CommentReviewParams),
  concludeUnreviewed: (job, summary) =>
    concludeCheck(job.payload as ReviewParams, job.checkRunId as number, summary),
  reportFailure: (job) =>
    reportReviewFailure(job.payload as ReviewParams, job.prId, job.kind),
};

const NOT_REVIEWED_DEADLINE =
  "Не разобрано: разбор не успел выполниться вовремя. Слияние разрешено, разбор будет " +
  "выполнен позже.";
const NOT_REVIEWED_FAILED =
  "Не разобрано: разбор не удался. Руководитель может перезапустить его из панели.";
const NOT_REVIEWED_LIMIT =
  "Не разобрано: исчерпан дневной лимит разборов проекта. Слияние разрешено, разбор будет " +
  "выполнен, когда лимит обновится.";

/** Conclude checks whose jobs missed the deadline; the jobs keep retrying. */
export async function concludeOverdue(deps: WorkerDeps = realDeps): Promise<void> {
  for (const job of listOverdueJobs()) {
    try {
      await deps.concludeUnreviewed(job, NOT_REVIEWED_DEADLINE);
      markCheckConcluded(job.id, "deadline");
    } catch (error) {
      console.error(`[queue] failed to conclude overdue check of job ${job.id}:`, error);
    }
  }
}

/** Conclude the job's check if it is still open; failures are logged, not thrown. */
async function concludeIfOpen(job: ReviewJob, summary: string, deps: WorkerDeps): Promise<boolean> {
  if (job.kind !== "commit" || job.checkRunId === null || job.checkConcluded) return false;
  try {
    await deps.concludeUnreviewed(job, summary);
    return true;
  } catch (error) {
    console.error(`[queue] failed to conclude check of job ${job.id}:`, error);
    return false;
  }
}

/** Run one job: pause, daily limit, execution, retries with backoff, final failure. */
export async function runJob(job: ReviewJob, deps: WorkerDeps = realDeps): Promise<void> {
  const settings = queueSettings();

  if (getProject(job.projectId)?.status !== "active") {
    await concludeIfOpen(job, "Проект на паузе — разбор не выполняется.", deps);
    finishJob(job.id, "superseded", "project paused");
    return;
  }

  const recent = recentAnalysesOfProject(job.projectId);
  if (recent.count >= settings.dailyLimit) {
    if (await concludeIfOpen(job, NOT_REVIEWED_LIMIT, deps)) markCheckConcluded(job.id, "limit");
    rescheduleJob(job.id, { at: recent.freeAt ?? undefined, delayMs: 60 * 60_000 });
    return;
  }

  if (!markJobRunning(job.id)) return; // replaced meanwhile
  try {
    if (job.kind === "commit") await deps.runCommit(job);
    else await deps.runComment(job);
    finishJob(job.id, "done");
  } catch (error) {
    if (error instanceof StaleReviewError) {
      await concludeIfOpen(job, "Заменён новым коммитом — разбирается последний.", deps);
      finishJob(job.id, "superseded");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const age = Date.now() - (parseDbDate(job.createdAt)?.getTime() ?? Date.now());
    if (age >= settings.retryWindowMs) {
      console.error(`[queue] job ${job.id} failed for good:`, error);
      finishJob(job.id, "failed", message);
      if (await concludeIfOpen(job, NOT_REVIEWED_FAILED, deps)) {
        markCheckConcluded(job.id, "deadline");
      }
      await deps.reportFailure(job).catch((reportError) => {
        console.error(`[queue] failed to report failure of job ${job.id}:`, reportError);
      });
      return;
    }
    // Backoff: 1, 2, 4 … minutes, at most 30.
    const attempts = job.attempts + 1;
    const delayMs = Math.min(2 ** (attempts - 1), 30) * 60_000;
    console.warn(
      `[queue] job ${job.id} attempt ${attempts} failed, retry in ${delayMs / 60_000} min:`,
      message,
    );
    rescheduleJob(job.id, { delayMs }, message);
  }
}

/** Open PRs of active projects without a finished review of their head get a job. */
async function syncOpenPullRequests(): Promise<void> {
  for (const project of listAllProjects()) {
    if (project.status !== "active") continue;
    try {
      const installationId = await getRepoInstallationId(project.owner, project.repo);
      const token = await getInstallationToken(installationId);
      const pulls = await githubRequest<
        Array<{
          number: number;
          draft: boolean;
          author_association: string;
          title: string;
          user: { login: string } | null;
          head: { sha: string };
        }>
      >(`/repos/${project.owner}/${project.repo}/pulls?state=open&per_page=100`, { token });
      for (const pr of pulls) {
        if (pr.draft) continue;
        const member = await isProjectMember({
          owner: project.owner,
          repo: project.repo,
          login: pr.user?.login,
          association: pr.author_association,
          installationId,
        });
        if (!member) continue;
        await startCommitReview(
          {
            owner: project.owner,
            repo: project.repo,
            prNumber: pr.number,
            headSha: pr.head.sha,
            installationId,
            author: pr.user?.login ?? null,
            title: pr.title,
          },
          "sync",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[queue] sync of ${project.owner}/${project.repo} failed: ${message}`);
    }
  }
}

const inFlight = new Set<number>();
let lastSweep = 0;

async function tick(): Promise<void> {
  // A job left "running" by a crashed run would block its project until a restart.
  const stray = requeueStrayRunningJobs(inFlight);
  if (stray > 0) console.warn(`[queue] ${stray} stray running job(s) back in the queue`);
  await concludeOverdue();

  const settings = queueSettings();
  const free = settings.concurrency - inFlight.size;
  if (free > 0) {
    for (const job of listDueJobs(settings.concurrency)) {
      if (inFlight.size >= settings.concurrency) break;
      if (inFlight.has(job.id)) continue;
      inFlight.add(job.id);
      void runJob(job)
        .catch((error) => console.error(`[queue] job ${job.id} crashed:`, error))
        .finally(() => inFlight.delete(job.id));
    }
  }

  if (Date.now() - lastSweep >= SWEEP_MS) {
    lastSweep = Date.now();
    try {
      backupDatabase();
    } catch (error) {
      console.error("[queue] database backup failed:", error);
    }
    await syncOpenPullRequests();
  }
}

type WorkerState = { started: boolean; busy: boolean };
const state: WorkerState = ((globalThis as { __curatorWorker?: WorkerState }).__curatorWorker ??= {
  started: false,
  busy: false,
});

/** Start the worker once per process; only the language-model reviewer uses the queue. */
export function startWorker(): void {
  if (state.started) return;
  let reviewer: string;
  try {
    reviewer = getConfig().reviewer;
  } catch (error) {
    console.error("[queue] not started, service not configured:", error);
    return;
  }
  if (reviewer !== "llm") return;
  state.started = true;
  const requeued = requeueRunningJobs();
  if (requeued > 0) console.log(`[queue] ${requeued} interrupted job(s) back in the queue`);
  setInterval(() => {
    if (state.busy) return;
    state.busy = true;
    tick()
      .catch((error) => console.error("[queue] tick failed:", error))
      .finally(() => {
        state.busy = false;
      });
  }, TICK_MS);
}
