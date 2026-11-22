import { getDb } from "@/lib/db";
import { collectFullReviewContext, selectPriorFindings } from "./context";
import { recordJobEvent, saveAnalysisDiagnostics } from "./diagnostics";
import { hashText } from "./context-parts";
import { runPrPipeline, type PrPipelineResult } from "./pr-pipeline";
import { sqlitePipelineStore } from "./pipeline-store";
import { withReviewRepository } from "./pr-full-diff";
import { durablePipelineBudget, loadPipelineJob, patchPipelineJob, pipelineConfigurationFingerprint, pipelineFailure, PipelineWaitError } from "./pipeline-job";
import { confirmMergedFixes, renderComment, afterReviewReconciliation, StaleReviewError, type ReviewOutcome, type ReviewParams, type ReviewRunContext } from "./review";
import { applyReconciliation, getPullRequest, loadOpenFindings, recordAnalysis, saveReviewResult } from "./store";
import type { PrPipelineOptions } from "./pr-pipeline";
import { automaticallyRetryExecution } from "@/lib/llm/execution";

export interface ContextReviewDependencies {
  targets: Awaited<ReturnType<typeof import("@/lib/agent/pr-targets.mts")["configuredPrTargets"]>>;
  withRepository: typeof withReviewRepository;
  ask?: PrPipelineOptions["ask"];
}

export async function runContextReview(params: ReviewParams, prId: number, jobId: number, context: ReviewRunContext, dependencies?: ContextReviewDependencies): Promise<ReviewOutcome> {
  let targets: ContextReviewDependencies["targets"];
  try { targets = dependencies?.targets ?? (await import("@/lib/agent/pr-targets.mts")).configuredPrTargets(); }
  catch {
    patchPipelineJob(jobId, { quality: "not_reviewed", recovery: "blocked", reason: "model_configuration", configuration: pipelineConfigurationFingerprint() });
    throw new PipelineWaitError("model_configuration", "blocked");
  }
  const previousBudget = loadPipelineJob(jobId).budget;
  const cacheMaximum = Math.max(1, (previousBudget?.spent.input ?? 0) + (previousBudget?.spent.output ?? 0) + (previousBudget?.unknownTokens ?? 0));
  const execution = durablePipelineBudget(jobId, context.cacheOnly ? cacheMaximum : targets.maxTokens, targets.timeoutMs), { budget } = execution;
  const configuration = pipelineConfigurationFingerprint();
  let input: Awaited<ReturnType<typeof collectFullReviewContext>> | undefined;
  let result: PrPipelineResult | undefined;
  const record = (outcome: "ok" | "partial" | "error" | "stale", reason?: string) => saveReviewResult(() => {
    execution.persist();
    const charged = getDb().prepare(`SELECT COALESCE(SUM(tokens_in),0) AS input, COALESCE(SUM(tokens_out),0) AS output
      FROM analyses WHERE json_extract(diagnostics_json,'$.jobId')=?`).get(jobId) as { input: number; output: number };
    const id = recordAnalysis({ prId, headSha: params.headSha, trigger: "commit", outcome, mode: "context",
      provider: [...new Set(budget.calls.map(c => c.provider))].join("+") || targets.primary.provider,
      model: targets.primary.model.id, materials: input?.materials, summary: result?.result.summary ?? reason,
      rawResponse: result ? JSON.stringify(result.result) : reason, tokensIn: Math.max(0, budget.spent.input - charged.input),
      tokensOut: Math.max(0, budget.spent.output - charged.output), overviewReason: outcome === "ok" ? result?.result.refreshOverview : null });
    saveAnalysisDiagnostics(id, { ...result?.diagnostics, version: 1, jobId, reason: reason ?? (result?.quality === "complete" ? "completed" : "limited"), budget: budget.snapshot(), calls: budget.calls,
      quality: result?.quality ?? "not_reviewed", recovery: outcome === "ok" || outcome === "partial" ? "terminal" : loadPipelineJob(jobId).recovery,
      delivery: outcome === "ok" || outcome === "partial" ? "pending" : "not_applicable", configuration });
    return id;
  });
  try {
    await (dependencies?.withRepository ?? withReviewRepository)(params, async repository => {
      const pinned = loadPipelineJob(jobId);
      if (pinned.revisions && pinned.revisions.head !== repository.head) throw new StaleReviewError();
      const revisions = { base: repository.base, mergeBase: repository.mergeBase, head: repository.head };
      const sameRevision = !pinned.revisions || pinned.revisions.base === repository.base && pinned.revisions.mergeBase === repository.mergeBase;
      if (!sameRevision) recordJobEvent(jobId, { type: "pr_base_replanned", previous: pinned.revisions, revisions });
      input = (sameRevision ? pinned.input as typeof input : undefined) ?? await collectFullReviewContext(params, prId, repository);
      patchPipelineJob(jobId, { revisions, input, configuration, delivery: "not_applicable" });
      result = await runPrPipeline({ repository, context: input.prompt, ...targets, budget,
        prior: input.prior, dismissed: input.dismissed, responses: input.responses, ask: dependencies?.ask,
        store: sqlitePipelineStore(`pr:${jobId}:` + hashText(JSON.stringify(revisions)), jobId),
        capabilityKey: configuration, onEvent: event => { recordJobEvent(jobId, event); execution.persist(); } });
      const issues = result.diagnostics.issues as Array<{ reason: string; retryable: boolean }>;
      if (issues.some(i => i.retryable || automaticallyRetryExecution(i.reason))) throw new PipelineWaitError(issues.find(i => i.retryable || automaticallyRetryExecution(i.reason))!.reason, "retryable");
      const blocked = issues.find(i => ["token_limit", "invalid_format", "output_limit", "daily_capacity", "model_configuration", "configuration_error", "provider_http"].includes(i.reason));
      if (blocked) throw new PipelineWaitError(blocked.reason, "blocked");
      if (context.isCurrent && !context.isCurrent() || context.validateCurrent && !await context.validateCurrent()) throw new StaleReviewError();
    }, budget);
    if (!result || !input) throw new Error("Missing PR pipeline result");
    const completed = result, captured = input;
    const capturedPr = getPullRequest(prId);
    const fixesFinal = context.fixesFinal?.() ?? false;
    const finalFixIds = fixesFinal ? await confirmMergedFixes(params, loadOpenFindings(prId).filter(f =>
      completed.result.findings.some(c => c.priorId === f.id && c.status === "closed")), params.headSha) : undefined;
    // The final network validation follows merge-fix lookups too; no await remains before apply.
    const { githubRequest } = await import("@/lib/github/api");
    const { getInstallationToken } = await import("@/lib/github/auth");
    const current = await githubRequest<{ head: { sha: string }; base: { sha: string }; state?: string; merged?: boolean }>(
      `/repos/${params.owner}/${params.repo}/pulls/${params.prNumber}`, { token: await getInstallationToken(params.installationId) });
    if (current.head.sha !== params.headSha || current.state === "closed" && !current.merged) throw new StaleReviewError();
    if (current.base.sha !== loadPipelineJob(jobId).revisions?.base) {
      patchPipelineJob(jobId, { revisions: undefined, input: undefined });
      throw new PipelineWaitError("base_changed", "retryable");
    }
    if (current.merged && capturedPr?.state !== "merged" ||
      context.fixesFinal && context.fixesFinal() !== fixesFinal) throw new PipelineWaitError("pr_state_changed", "retryable");
    if (context.isCurrent && !context.isCurrent()) throw new StaleReviewError();
    return saveReviewResult(() => {
      const outcome = completed.quality === "complete" ? "ok" : "partial";
      const analysisId = record(outcome);
      const { statusChanges, kept } = applyReconciliation(prId, analysisId, completed.result, {
        allowedPriorIds: new Set(captured.prior.map(p => p.id)), reopenableIds: new Set(captured.dismissed.map(p => p.id)),
        allowNew: true, changed: completed.changed, fixesFinal, finalFixIds, branch: params.headRef ?? getPullRequest(prId)?.headRef ?? null,
      });
      afterReviewReconciliation(params, prId, "commit", fixesFinal, kept);
      const others = selectPriorFindings(loadOpenFindings(prId).filter(f => !statusChanges.some(c => c.findingId === f.id) && !kept.some(k => k.findingId === f.id)), params.prNumber);
      const limited = completed.quality === "limited" ? "\n\n**Разбор с ограничениями.** Непроверенные вопросы сохранены; прежние замечания не закрывались. Подробности видны руководителю.\n" : "";
      const report: ReviewOutcome = { analysisId, comment: renderComment(completed.result, statusChanges, captured.materials, { kept, others }) + limited,
        outcome, summary: completed.result.summary, statusChanges, kept };
      patchPipelineJob(jobId, { quality: completed.quality, recovery: "terminal", delivery: "pending", reason: completed.quality === "complete" ? "completed" : "limited" });
      context.stage?.(report);
      return report;
    });
  } catch (error) {
    if (error instanceof StaleReviewError || error instanceof Error && error.message.startsWith("superseded:")) { record("stale", "superseded"); throw new StaleReviewError(); }
    const failure = pipelineFailure(error);
    const wait = context.cacheOnly && failure.reason === "token_limit" ? new PipelineWaitError("daily_tokens", "retryable") : failure;
    patchPipelineJob(jobId, { quality: result?.quality ?? "not_reviewed", recovery: wait.recovery, reason: wait.reason, configuration });
    record("error", wait.reason);
    throw wait;
  } finally { execution.persist(); }
}
