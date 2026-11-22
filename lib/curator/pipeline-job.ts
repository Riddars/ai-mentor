import { getDb } from "@/lib/db";
import { ExecutionBudget, ExecutionBudgetError, type ExecutionBudgetSnapshot } from "@/lib/llm/execution";
import { hashText } from "./context-parts";
import { recordJobEvent } from "./diagnostics";
import { initialMapPrompt, prContextPrompt, prContextVerifyPrompt } from "./prompts";
import { recentTokens } from "./store";

export const CONTEXT_PIPELINE_VERSION = "context-v3.3";
export function pipelineConfigurationFingerprint(): string {
  const settings = ["LLM_PROVIDER", "LLM_MODEL", "AGENT_MODEL", "LLM_FALLBACK_PROVIDER", "LLM_FALLBACK_MODEL",
    "PR_CONTEXT_TOKENS", "INITIAL_MAP_CONTEXT_TOKENS", "LLM_FALLBACK_CONTEXT_TOKENS", "PR_TOKENS_PER_RUN", "OVERVIEW_TOKENS_PER_RUN", "PR_TIMEOUT_MS", "INITIAL_OVERVIEW_MODE", "TOKENS_PER_DAY", "TOKENS_PER_PROJECT_DAY"];
  return hashText(JSON.stringify([CONTEXT_PIPELINE_VERSION, settings.map(k => [k, process.env[k]]),
    ["SELECTEL_API_KEY", "PROVOD_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"].map(k => hashText(process.env[k] ?? "")),
    initialMapPrompt(), prContextPrompt(false), prContextPrompt(true), prContextVerifyPrompt()]));
}
export interface PipelineJobState {
  version: string;
  budget?: ExecutionBudgetSnapshot;
  revisions?: { base: string; mergeBase: string; head: string };
  input?: unknown;
  quality?: "complete" | "limited" | "not_reviewed";
  recovery?: "retryable" | "blocked" | "terminal";
  delivery?: "pending" | "delivered" | "not_applicable";
  reason?: string;
  configuration?: string;
}
export function loadPipelineJob(jobId: number): PipelineJobState {
  const row = getDb().prepare("SELECT json_extract(payload,'$.contextPipeline') AS state FROM review_jobs WHERE id=?").get(jobId);
  if (!row) throw new Error("Pipeline job no longer exists");
  return typeof row.state === "string" ? JSON.parse(row.state) as PipelineJobState : { version: CONTEXT_PIPELINE_VERSION };
}
export function patchPipelineJob(jobId: number, patch: Partial<PipelineJobState>): PipelineJobState {
  const value = { ...loadPipelineJob(jobId), ...patch, version: CONTEXT_PIPELINE_VERSION };
  getDb().prepare("UPDATE review_jobs SET payload=json_set(payload,'$.contextPipeline',json(?)) WHERE id=?")
    .run(JSON.stringify(value), jobId);
  return value;
}
/** Every attempt has a fresh active deadline, but all attempts share one token allowance. */
export function durablePipelineBudget(jobId: number, maxTokens: number, timeoutMs: number) {
  const previous = loadPipelineJob(jobId).budget;
  const interrupted = previous?.calls.filter(c => c.status === "started") ?? [];
  const persist = () => patchPipelineJob(jobId, { budget: budget.snapshot() });
  const budget = new ExecutionBudget({ maxTokens, deadlineAt: Date.now() + timeoutMs,
    spent: previous?.spent, toolCalls: previous?.toolCalls, outputChars: previous?.outputChars,
    unknownTokens: (previous?.unknownTokens ?? 0) + interrupted.reduce((sum, call) => sum + (call.reservedTokens ?? 0), 0),
    calls: previous?.calls.map(c => c.status === "started" ? { ...c, status: "unknown", completionReason: "interrupted", usageSource: "unknown" } : c),
    beforeCall(call) { admitPipelineDailyCall(jobId, call.reservedTokens ?? 0); },
    onCall(call) { persist(); recordJobEvent(jobId, { type: "llm_call_accounting", ...call }); },
  });
  persist();
  return { budget, persist };
}
export class PipelineWaitError extends Error {
  constructor(readonly reason: string, readonly recovery: "blocked" | "retryable") {
    super(`Разбор ожидает ${recovery === "blocked" ? "изменения настроек" : "повтора сервиса"}: ${reason}`);
  }
}
export function blockedPipelineConfiguration(jobId: number): PipelineWaitError {
  patchPipelineJob(jobId, { quality: "not_reviewed", recovery: "blocked", reason: "configuration_error", configuration: pipelineConfigurationFingerprint(), delivery: "not_applicable" });
  recordJobEvent(jobId, { type: "pipeline_wait", reason: "configuration_error", recovery: "blocked" });
  return new PipelineWaitError("configuration_error", "blocked");
}
export function pipelineFailure(error: unknown): PipelineWaitError {
  if (error instanceof PipelineWaitError) return error;
  const reason = error instanceof ExecutionBudgetError ? error.reason :
    error && typeof error === "object" && "reason" in error ? String(error.reason) :
      error instanceof Error && /invalid_format|context_limit|incomplete_snapshot|configuration_error/.test(error.message) ? error.message.split(":")[0] : "process_failure";
  const blocked = ["token_limit", "context_limit", "invalid_format", "output_limit", "incomplete_snapshot", "no_progress", "stall", "configuration_error", "model_configuration", "daily_capacity"].includes(reason) ||
    !!error && typeof error === "object" && "retryable" in error && error.retryable === false;
  return new PipelineWaitError(reason, blocked ? "blocked" : "retryable");
}
/** No clock-based paid retries for a persistent blocker; wake only after configuration changes. */
export function wakeChangedPipelineJobs(): number {
  const configuration = pipelineConfigurationFingerprint();
  const rows = getDb().prepare("SELECT id, json_extract(payload,'$.contextPipeline.configuration') AS configuration FROM review_jobs WHERE status='queued' AND note='pipeline-blocked'").all();
  let woke = 0;
  for (const row of rows) if (row.configuration !== configuration) {
    getDb().prepare("UPDATE review_jobs SET note=NULL, run_after=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='queued'").run(row.id);
    recordJobEvent(Number(row.id), { type: "pipeline_configuration_changed", configuration }); woke++;
  }
  return woke;
}
export function waitPipelineJob(jobId: number, wait: PipelineWaitError, delayMs: number): void {
  getDb().prepare("UPDATE review_jobs SET status='queued', note=?, last_error=?, run_after=datetime('now',?), updated_at=datetime('now') WHERE id=? AND status='running'")
    .run(wait.recovery === "blocked" ? "pipeline-blocked" : null, wait.message, `+${Math.max(1, Math.ceil(delayMs / 1000))} seconds`, jobId);
}
export function hasSavedPipelineFinal(jobId: number): boolean {
  return !!getDb().prepare("SELECT 1 FROM context_pipeline_parts WHERE job_id=? AND part_id IN ('pr-final','final') LIMIT 1").get(jobId);
}

/** Admission liability, separate from billed UI usage: in-flight/unknown and unrecorded usage. */
export function pipelineDailyLiability(projectId: number | null): number {
  const rows = getDb().prepare(`SELECT j.id, j.status, j.kind, j.payload,
    COALESCE((SELECT SUM(COALESCE(a.tokens_in,0)+COALESCE(a.tokens_out,0)) FROM analyses a
      WHERE json_extract(a.diagnostics_json,'$.jobId')=j.id AND a.created_at>datetime('now','-1 day')),0) AS billed
    FROM review_jobs j JOIN pull_requests pr ON pr.id=j.pull_request_id
    WHERE (@projectId IS NULL OR pr.project_id=@projectId) AND j.updated_at>datetime('now','-1 day')`).all({ projectId });
  const since = Date.now() - 86400000;
  let liability = 0;
  for (const row of rows) {
    const payload = JSON.parse(String(row.payload)) as { reviewMode?: string; initialMapMode?: string; contextPipeline?: PipelineJobState; checkpoint?: { budget?: ExecutionBudgetSnapshot } };
    const snapshot = payload.contextPipeline?.budget ?? payload.checkpoint?.budget;
    const calls = snapshot?.calls.filter(c => c.startedAt > since) ?? [];
    const known = calls.reduce((sum, c) => sum + c.inputTokens + c.outputTokens, 0);
    const unknown = calls.filter(c => c.status === "started" || c.status === "unknown").reduce((sum, c) => sum + (c.reservedTokens ?? 0), 0);
    liability += Math.max(0, known - Number(row.billed)) + unknown;
  }
  return liability;
}
/** Synchronous before-start admission: reserve this request, not an entire 950k cap for a tiny PR. */
export function admitPipelineDailyCall(jobId: number, requestTokens: number, ignoreProject = false): void {
  const row = getDb().prepare("SELECT pr.project_id AS project FROM review_jobs j JOIN pull_requests pr ON pr.id=j.pull_request_id WHERE j.id=?").get(jobId);
  if (!row) throw new Error("Pipeline job no longer exists");
  const total = Number(process.env.TOKENS_PER_DAY ?? 5000000), project = Number(process.env.TOKENS_PER_PROJECT_DAY ?? 1000000);
  if (total > 0 && requestTokens > total || !ignoreProject && project > 0 && requestTokens > project) throw new ExecutionBudgetError("daily_capacity");
  if (total > 0 && recentTokens(null) + pipelineDailyLiability(null) + requestTokens > total ||
    !ignoreProject && project > 0 && recentTokens(Number(row.project)) + pipelineDailyLiability(Number(row.project)) + requestTokens > project) throw new ExecutionBudgetError("daily_tokens");
}
