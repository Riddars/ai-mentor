import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { withRepositoryCopy } from "@/lib/agent/run";
import { getRepoInstallationId } from "@/lib/github/auth";
import { getConfig } from "@/lib/config";
import { defaultBranchHead } from "./memory";
import { repositoryInventory } from "./repository-inventory";
import { SNAPSHOT_POLICY_VERSION } from "./snapshot-policy";
import { sqlitePipelineStore } from "./pipeline-store";
import { hashText, sourceUnit, unitText } from "./context-parts";
import { durablePipelineBudget, patchPipelineJob, pipelineConfigurationFingerprint, pipelineFailure, PipelineWaitError, loadPipelineJob } from "./pipeline-job";
import { recordJobEvent, saveAnalysisDiagnostics } from "./diagnostics";
import { getProject, getProjectNotes, recordAnalysis, setAnalysisComment, saveReviewResult, applyReconciliation, type ReviewJob, type AnalysisOutcome } from "./store";
import { auditMap, latestProjectMap, projectAuditEnabled, enqueueProjectAudit, loadAuditHistory, auditHistoryHash,
  savedAuditInput, saveAuditInput, completedAudit, completeAudit, AUDIT_VERSION } from "./project-audit-store";
import { searchProject, verifyProjectCandidates, type AuditInput, type AuditPipelineOptions } from "./project-audit-pipeline";
import type { OverviewJobResult } from "./worker";

const positive = (key: string, fallback: number) => {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("configuration_error: invalid " + key);
  return value;
};
export async function startProjectAudit(projectId: number): Promise<"queued" | "active" | "disabled" | "map_required" | "paused"> {
  if (!projectAuditEnabled() || getConfig().reviewer !== "llm") return "disabled";
  const project = getProject(projectId);
  if (!project || project.status !== "active") return "paused";
  const map = latestProjectMap(projectId);
  if (!map) return "map_required";
  const head = await defaultBranchHead(project, await getRepoInstallationId(project.owner, project.repo));
  return head !== map.sha ? "map_required" : enqueueProjectAudit(map);
}
export interface AuditDependencies {
  withCopy?: typeof withRepositoryCopy;
  head?: typeof defaultBranchHead;
  installation?: typeof getRepoInstallationId;
  ask?: AuditPipelineOptions["ask"];
}
/** No outbox or GitHub mutation exists on this path, including retries and failures. */
export async function executeProjectAuditJob(job: ReviewJob, cacheOnly = false, deps: AuditDependencies = {}): Promise<OverviewJobResult> {
  const finished = completedAudit(job.id);
  if (finished !== null) return { quality: "complete", analysisId: finished };
  const configuration = pipelineConfigurationFingerprint();
  if (!projectAuditEnabled()) {
    patchPipelineJob(job.id, { quality: "not_reviewed", recovery: "blocked", reason: "project_audit_disabled", configuration, delivery: "not_applicable" });
    throw new PipelineWaitError("project_audit_disabled", "blocked");
  }
  const project = getProject(job.projectId);
  if (!project) throw new Error("Project does not exist");
  const map = auditMap(job.id);
  let maximum: number, timeout: number, contextTokens: number, fallbackContextTokens: number;
  try {
    maximum = positive("PROJECT_AUDIT_TOKENS_PER_RUN", 950000);
    timeout = positive("PROJECT_AUDIT_TIMEOUT_MS", 20 * 60000);
    contextTokens = positive("PROJECT_AUDIT_CONTEXT_TOKENS", positive("INITIAL_MAP_CONTEXT_TOKENS", 128000));
    fallbackContextTokens = positive("LLM_FALLBACK_CONTEXT_TOKENS", contextTokens);
  } catch { patchPipelineJob(job.id, { configuration }); throw new PipelineWaitError("configuration_error", "blocked"); }
  const priorBudget = loadPipelineJob(job.id).budget;
  const cacheMaximum = Math.max(1, (priorBudget?.spent.input ?? 0) + (priorBudget?.spent.output ?? 0) + (priorBudget?.unknownTokens ?? 0));
  const { budget, persist } = durablePipelineBudget(job.id, cacheOnly ? cacheMaximum : maximum, timeout);
  const store = sqlitePipelineStore(AUDIT_VERSION + ":" + job.id, job.id);
  let result: Awaited<ReturnType<typeof verifyProjectCandidates>> | undefined;
  let search: Awaited<ReturnType<typeof searchProject>> | undefined;
  const record = (outcome: AnalysisOutcome, summary: string, details: unknown) => {
    persist();
    const charged = getDb().prepare(`SELECT COALESCE(SUM(tokens_in),0) AS input,COALESCE(SUM(tokens_out),0) AS output
      FROM analyses WHERE json_extract(diagnostics_json,'$.jobId')=?`).get(job.id) as { input: number; output: number };
    const id = recordAnalysis({ prId: job.prId, headSha: map.sha, trigger: "project_audit", outcome, mode: "context",
      summary, rawResponse: JSON.stringify(details), model: process.env.LLM_MODEL ?? null,
      provider: [...new Set(budget.calls.map(c => c.provider))].join("+") || null,
      tokensIn: Math.max(0, budget.spent.input - charged.input), tokensOut: Math.max(0, budget.spent.output - charged.output) });
    saveAnalysisDiagnostics(id, { version: 1, jobId: job.id, reason: outcome === "ok" ? "completed" : outcome === "stale" ? "superseded" : outcome === "partial" ? "limited" : loadPipelineJob(job.id).reason,
      budget: budget.snapshot(), calls: budget.calls, mapId: map.id, mapAnalysisId: map.analysisId, sha: map.sha, search, verification: result,
      unresolved: [...(search?.unresolved ?? []), ...(result?.unresolved ?? [])], delivery: "not_applicable", details });
    setAnalysisComment(id, [summary, `Версия проекта: \`${map.sha}\`.`,
      ...(result?.accepted.map(f => `- ${f.title}`) ?? []),
      ...[...(search?.unresolved ?? []), ...(result?.unresolved ?? [])].map(q => `Непроверенный вопрос: ${q}`)].join("\n\n"));
    return id;
  };
  try {
    const installationId = await (deps.installation ?? getRepoInstallationId)(project.owner, project.repo);
    await (deps.withCopy ?? withRepositoryCopy)({ owner: project.owner, repo: project.repo, installationId, headSha: map.sha }, budget, async root => {
      const scratch = await mkdtemp(join(tmpdir(), "curator-audit-views-"));
      try {
        const inventory = await repositoryInventory(root, map.sha, scratch);
        const manifest = { version: SNAPSHOT_POLICY_VERSION, included: inventory.sources.map(s => ({ path: s.path, bytes: s.bytes, id: s.id, originalHash: s.originalHash,
          viewHash: s.viewHash, transformation: s.transformation, kind: s.kind })), excluded: inventory.excluded };
        if (hashText(JSON.stringify(manifest)) !== hashText(map.manifest)) throw new Error("incomplete_snapshot: map and audit file manifests differ");
        const requirements: Record<string, string> = {};
        for (const source of inventory.sources) if (["RESEARCH.md", "PLAN.md"].includes(source.path) && source.kind === "file") requirements[source.path] = await unitText(sourceUnit(source));
        const input = savedAuditInput(job.id) as AuditInput | null ?? { sha: map.sha, map: map.body, notes: getProjectNotes(project.id)?.body ?? null, requirements, history: loadAuditHistory(project.id) };
        saveAuditInput(job.id, input);
        const options: AuditPipelineOptions = { sources: inventory.sources, excluded: inventory.excluded, input, budget, store,
          configuration,
          limits: { contextTokens, outputTokens: 8000, safetyRatio: 0.15 }, fallbackContextTokens, ask: deps.ask };
        search = await searchProject(options);
        for (let attempt = 0; attempt < 3; attempt++) {
          const history = loadAuditHistory(project.id), notesId = getProjectNotes(project.id)?.id ?? null;
          // Updated requirements/history only rerun verification; completed source search stays cached.
          const currentOptions = { ...options, input: { ...input, notes: getProjectNotes(project.id)?.body ?? null } };
          result = await verifyProjectCandidates(currentOptions, search.findings, history);
          store.save("audit-final", hashText(JSON.stringify([auditHistoryHash(history), notesId, map.sha])), {
            content: JSON.stringify(result), provider: "internal", model: AUDIT_VERSION, usage: { input: 0, output: 0 } });
          const head = await (deps.head ?? defaultBranchHead)(project, installationId);
          const stable = saveReviewResult(() => {
            if (auditHistoryHash(loadAuditHistory(project.id)) !== auditHistoryHash(history) || (getProjectNotes(project.id)?.id ?? null) !== notesId) return false;
            if (completedAudit(job.id) !== null) return true;
            if (head !== map.sha || latestProjectMap(project.id)?.id !== map.id) {
              const id = record("stale", "Поиск выполнен для старой версии. Обновите карту проекта.", { head, search, result });
              completeAudit(job.id, id); return true;
            }
            const unresolved = [...search!.unresolved, ...result!.unresolved];
            const summary = unresolved.length ? `Поиск с ограничениями: новых подтверждённых замечаний ${result!.accepted.length}, непроверенных вопросов ${unresolved.length}.`
              : `Поиск завершён: новых подтверждённых замечаний ${result!.accepted.length}.`;
            const id = record(unresolved.length ? "partial" : "ok", summary, { search, result, unresolved });
            applyReconciliation(job.prId, id, { summary, findings: result!.accepted, notes: null }, {
              allowedPriorIds: new Set(), reopenableIds: new Set(), allowNew: true, fixesFinal: true, wholeRepository: true, changed: new Map() });
            completeAudit(job.id, id);
            patchPipelineJob(job.id, { quality: unresolved.length ? "limited" : "complete", recovery: "terminal", delivery: "not_applicable", reason: unresolved.length ? "limited" : "completed", configuration });
            return true;
          });
          if (stable) return;
          recordJobEvent(job.id, { type: "audit_history_changed", attempt });
        }
        throw new PipelineWaitError("history_changed", "retryable");
      } finally { await rm(scratch, { recursive: true, force: true }); }
    });
    return { quality: "complete", analysisId: completedAudit(job.id)! };
  } catch (error) {
    const failure = pipelineFailure(error);
    const wait = cacheOnly && failure.reason === "token_limit" ? new PipelineWaitError("daily_tokens", "retryable") : failure;
    patchPipelineJob(job.id, { quality: "not_reviewed", recovery: wait.recovery, reason: wait.reason, configuration, delivery: "not_applicable" });
    saveReviewResult(() => record("error", `Поиск не завершён: ${wait.reason}`, { reason: wait.reason }));
    throw wait;
  } finally { persist(); }
}
