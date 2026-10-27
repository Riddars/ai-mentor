import { removeStaleAgentDirs } from "@/lib/agent/run";
import { backupDatabase } from "@/lib/db";
import { parseDbDate } from "@/lib/format";
import { getConfig } from "@/lib/config";
import { githubRequest } from "@/lib/github/api";
import { getInstallationToken, getRepoInstallationId } from "@/lib/github/auth";
import { isProjectMember } from "@/lib/github/members";
import { memoryGap } from "@/lib/curator/memory";
import { executeOverviewJob, OVERVIEW_LIMITS, startOverview, type OverviewPayload } from "@/lib/curator/overview";
import {
  concludeCheck,
  executeCommentJob,
  executeCommitJob,
  handlePullRequestClosed,
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
  listOpenPullRequestNumbers,
  listOverdueJobs,
  markCheckConcluded,
  markJobRunning,
  queueProblems,
  recentAnalysesOfProject,
  recentTokens,
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
const HEARTBEAT_MS = 5 * 60_000;

export interface WorkerDeps {
  runCommit(job: ReviewJob): Promise<void>;
  runComment(job: ReviewJob): Promise<void>;
  runOverview(job: ReviewJob): Promise<void>;
  concludeUnreviewed(job: ReviewJob, summary: string): Promise<void>;
  reportFailure(job: ReviewJob): Promise<void>;
}

const realDeps: WorkerDeps = {
  runCommit: (job) =>
    executeCommitJob(job.payload as ReviewParams, job.prId, job.id, job.attempts),
  runComment: (job) => executeCommentJob(job.payload as CommentReviewParams),
  runOverview: (job) => executeOverviewJob(job),
  concludeUnreviewed: (job, summary) =>
    concludeCheck(job.payload as ReviewParams, job.checkRunId as number, summary),
  // A failed overview is already recorded with what it spent; it has no PR to report to.
  reportFailure: async (job) => {
    if (job.kind !== "overview") await reportReviewFailure(job.payload as ReviewParams, job.prId, job.kind);
  },
};

/** An overview reads the whole project, so a failed one is repeated only once. */
const OVERVIEW_ATTEMPTS = 2;

const NOT_REVIEWED_DEADLINE =
  "Не разобрано: разбор не успел выполниться вовремя. Слияние разрешено, разбор будет " +
  "выполнен позже.";
const NOT_REVIEWED_FAILED =
  "Не разобрано: разбор не удался. Руководитель может перезапустить его из панели.";
const NOT_REVIEWED_LIMIT =
  "Не разобрано: исчерпан дневной лимит разборов проекта. Слияние разрешено, разбор будет " +
  "выполнен, когда лимит обновится.";
const NOT_REVIEWED_PROJECT_TOKENS =
  "Не разобрано: исчерпан дневной бюджет токенов проекта. Слияние разрешено, разбор будет " +
  "выполнен, когда бюджет обновится.";
const NOT_REVIEWED_TOKENS =
  "Не разобрано: исчерпан общий дневной бюджет токенов. Слияние разрешено, разбор будет " +
  "выполнен, когда бюджет обновится.";

/** Conclude checks whose jobs missed the deadline; the jobs keep retrying. */
export async function concludeOverdue(deps: WorkerDeps = realDeps): Promise<void> {
  for (const job of listOverdueJobs()) {
    markProgress();
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

/**
 * Run one job: pause, daily limits, execution, retries with backoff, final failure. Over a
 * limit there is no review at all: the check is concluded "not reviewed" and the job waits.
 * Budgets are checked before a run, so one run may overshoot by its own budget at most.
 */
export async function runJob(job: ReviewJob, deps: WorkerDeps = realDeps): Promise<void> {
  const settings = queueSettings();

  if (getProject(job.projectId)?.status !== "active") {
    await concludeIfOpen(job, "Проект на паузе — разбор не выполняется.", deps);
    finishJob(job.id, "superseded", "project paused");
    return;
  }

  const recent = recentAnalysesOfProject(job.projectId);
  // An overview starts only with room for its whole run left in the budgets. One a person asked
  // for (button, resume) is not held back by the project's budget, only by the service's.
  const reserve = job.kind === "overview" ? OVERVIEW_LIMITS.maxTokens : 0;
  const asked = job.kind === "overview" && ["manual", "resume"].includes((job.payload as OverviewPayload).reason);
  const overLimit =
    recent.count >= settings.dailyLimit
      ? NOT_REVIEWED_LIMIT
      : !asked && settings.projectDailyTokens > 0 && recentTokens(job.projectId) + reserve >= settings.projectDailyTokens
        ? NOT_REVIEWED_PROJECT_TOKENS
        : settings.dailyTokens > 0 && recentTokens(null) + reserve >= settings.dailyTokens
          ? NOT_REVIEWED_TOKENS
          : null;
  if (overLimit) {
    if (await concludeIfOpen(job, overLimit, deps)) {
      markCheckConcluded(job.id, overLimit === NOT_REVIEWED_LIMIT ? "limit" : "budget");
    }
    const at = overLimit === NOT_REVIEWED_LIMIT ? (recent.freeAt ?? undefined) : undefined;
    rescheduleJob(job.id, { at, delayMs: 60 * 60_000 });
    return;
  }

  if (!markJobRunning(job.id)) return; // replaced meanwhile
  try {
    if (job.kind === "commit") await deps.runCommit(job);
    else if (job.kind === "overview") await deps.runOverview(job);
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
    if (age >= settings.retryWindowMs || (job.kind === "overview" && job.attempts + 1 >= OVERVIEW_ATTEMPTS)) {
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

/** Main-branch heads seen with a memory gap on the previous sync, by project. */
const gapSeen = new Map<number, string>();

/**
 * A project without an overview gets one at once. Other gaps must be seen on two syncs in a
 * row at the same head, so a merge whose close event is still being handled is not taken
 * for one.
 */
async function checkMemoryGap(project: { id: number; owner: string; repo: string }, installationId: number): Promise<void> {
  const { gap, head, initial } = await memoryGap(project, installationId);
  if (!gap) {
    gapSeen.delete(project.id);
    return;
  }
  if (!initial && gapSeen.get(project.id) !== head) {
    gapSeen.set(project.id, head);
    return;
  }
  gapSeen.delete(project.id);
  if (startOverview(project.id, initial ? "initial" : "gap") === "queued") {
    console.log(`[queue] overview of ${project.owner}/${project.repo} queued (${initial ? "no overview yet" : "memory gap"})`);
  }
}

/**
 * Open PRs of active projects without a finished review of their head get a job; PRs open
 * in memory but not on GitHub had their close event lost and are closed now. A project whose
 * memory does not cover its main branch gets an overview.
 */
async function syncOpenPullRequests(): Promise<void> {
  for (const project of listAllProjects()) {
    if (project.status !== "active") continue;
    markProgress();
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
          head: { sha: string; ref: string };
          base: { ref: string };
        }>
      >(`/repos/${project.owner}/${project.repo}/pulls?state=open&per_page=100`, { token });
      // A page shorter than 100 lists every open PR; a full one may continue on the next page.
      if (pulls.length < 100) {
        const open = new Set(pulls.map((pr) => pr.number));
        for (const number of listOpenPullRequestNumbers(project.id)) {
          if (!open.has(number)) await handlePullRequestClosed(project, number, installationId);
        }
      }
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
            baseRef: pr.base.ref,
            headRef: pr.head.ref,
          },
          "sync",
        );
      }
      await checkMemoryGap(project, installationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[queue] sync of ${project.owner}/${project.repo} failed: ${message}`);
    }
  }
}

/**
 * Heartbeat to an external monitor: a GET of the URL while the queue is healthy, nothing
 * otherwise. A dead, stuck or failing worker goes silent, and the monitor alerts on that.
 */
async function sendHeartbeat(url: string): Promise<void> {
  let problems: string[];
  try {
    problems = queueProblems();
  } catch (error) {
    problems = [`queue state unreadable: ${error instanceof Error ? error.message : error}`];
  }
  if (problems.length) {
    console.warn(`[queue] heartbeat withheld: ${problems.join("; ")}`);
    return;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) console.warn(`[queue] heartbeat rejected: HTTP ${res.status}`);
  } catch (error) {
    console.warn(`[queue] heartbeat failed: ${error instanceof Error ? error.message : error}`);
  }
}

const inFlight = new Set<number>();
let lastSweep = 0;
let lastHeartbeat = 0;

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

  const heartbeatUrl = process.env.HEARTBEAT_URL;
  if (heartbeatUrl && Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = Date.now();
    await sendHeartbeat(heartbeatUrl);
  }
}

type WorkerState = { started: boolean; busy: boolean; progressAt: number };
const state: WorkerState = ((globalThis as { __curatorWorker?: WorkerState }).__curatorWorker ??= {
  started: false,
  busy: false,
  progressAt: 0,
});

const STALL_MS = 15 * 60_000;

/** Record that the current tick is moving on; a long sweep over many projects is not a stall. */
function markProgress(): void {
  state.progressAt = performance.now();
}

/** Whether the worker is down or its current tick has made no progress for STALL_MS. */
export function workerStalled(now = performance.now()): boolean {
  return !state.started || (state.busy && now - state.progressAt > STALL_MS);
}

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
  const requeued = requeueRunningJobs();
  if (requeued > 0) console.log(`[queue] ${requeued} interrupted job(s) back in the queue`);
  void removeStaleAgentDirs();
  setInterval(() => {
    if (state.busy) return;
    state.busy = true;
    markProgress();
    tick()
      .catch((error) => console.error("[queue] tick failed:", error))
      .finally(() => {
        state.busy = false;
      });
  }, TICK_MS);
  state.started = true;
}
