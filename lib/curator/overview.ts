import { getDb } from "@/lib/db";
import { saveProjectMap } from "./project-audit-store";
import { SNAPSHOT_POLICY_VERSION } from "./snapshot-policy";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { githubRequest } from "@/lib/github/api";
import { getInstallationToken, getRepoInstallationId } from "@/lib/github/auth";
import { emptySpend } from "@/lib/llm/spend";
import { ExecutionBudget, ExecutionBudgetError, type ExecutionBudgetSnapshot } from "@/lib/llm/execution";
import type { AgentDiagnostics } from "@/lib/agent/protocol";
import type { ResearchState } from "@/lib/agent/research";
import type { OverviewJobResult } from "@/lib/curator/worker";
import { AgentProcessError, agentModel, withAgentRun } from "@/lib/agent/run";
import { getConfig } from "@/lib/config";
import { isDataFile } from "@/lib/curator/data-files";
import { dismissedFindingsText, notesText, priorFindingsText, selectDismissedFindings, selectPriorFindings } from "@/lib/curator/context";
import { coverMemory, defaultBranchHead } from "@/lib/curator/memory";
import { parseOverviewDraft } from "@/lib/curator/overview-draft";
import { publicText } from "@/lib/curator/review";
import { overviewPrompt } from "@/lib/curator/prompts";
import { verifyFindings } from "@/lib/curator/verify";
import { getAnalysisDiagnostics, recordJobEvent, saveAnalysisDiagnostics } from "@/lib/curator/diagnostics";
import { admitPipelineDailyCall, blockedPipelineConfiguration, patchPipelineJob, pipelineConfigurationFingerprint, pipelineFailure, PipelineWaitError } from "./pipeline-job";
import {
  addProjectNotes,
  applyReconciliation,
  enqueueOverviewJob,
  getMemorySha,
  getOverviewIssue,
  getProject,
  getProjectNotes,
  loadDismissedFindings,
  loadOpenFindings,
  recordAnalysis,
  setAnalysisComment,
  setOverviewIssue,
  saveReviewResult,
  stageJobPublication,
  stagedJobPublication,
  type AnalysisOutcome,
  type ReviewJob,
} from "@/lib/curator/store";

// Project overview: the agent reads the whole main branch, finds major problems, reconciles the
// open findings with the current code and rewrites the notes about the project. The notes are
// published as one GitHub issue per project, updated in place when they change.

export type OverviewReason = "initial" | "gap" | "resume" | "manual" | "merge";

export interface OverviewPayload {
  reason: OverviewReason;
}

/** Larger than a PR review: the agent reads the project, not one change. */
export const OVERVIEW_LIMITS = { maxToolCalls: 60, maxTokens: 950_000, timeoutMs: 20 * 60_000 };
export function overviewTokenLimit(): number {
  const value = Number(process.env.OVERVIEW_TOKENS_PER_RUN ?? OVERVIEW_LIMITS.maxTokens);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("configuration_error: invalid OVERVIEW_TOKENS_PER_RUN");
  return value;
}

const ISSUE_TITLE = "Обзор проекта (AI Curator)";

/**
 * Queue an overview; a person's request, a resume or a merged PR whose review asked for it skip
 * the limit on automatic overviews.
 * An overview is an agent run: without the language-model reviewer and an agent model nothing
 * is queued.
 */
export function startOverview(
  projectId: number,
  reason: OverviewReason,
): "queued" | "active" | "recent" | "unavailable" {
  try {
    if (getConfig().reviewer !== "llm") return "unavailable";
    agentModel();
  } catch {
    return "unavailable";
  }
  const payload: OverviewPayload = { reason };
  // A person, a resume or a merged PR whose review named a reason skip the limit on automatic overviews.
  return enqueueOverviewJob(projectId, payload, reason !== "initial" && reason !== "gap", reason === "merge", reason === "manual");
}

const CODE_FILE = /\.(py|ipynb|r|jl|m|c|cc|cpp|h|hpp|java|js|ts|rs|go|sh|sql)$/i;

/** Code, a notebook or data: what makes a repository more than its templates. */
function isWorkFile(path: string): boolean {
  return !path.startsWith(".github/") && (CODE_FILE.test(path) || isDataFile(path));
}

/**
 * Whether a merged PR brought the first code or data: the commit the memory describes had
 * none, and the PR adds some. Such a merge is always followed by an overview.
 */
export async function bringsFirstWork(
  project: { id: number; owner: string; repo: string },
  prNumber: number,
  installationId: number,
): Promise<boolean> {
  const memory = getMemorySha(project.id);
  if (!memory) return false; // no overview yet: the memory gap check starts one
  const token = await getInstallationToken(installationId);
  const base = `/repos/${project.owner}/${project.repo}`;
  const files = await githubRequest<Array<{ filename: string; status: string }>>(
    `${base}/pulls/${prNumber}/files?per_page=100`,
    { token },
  );
  if (!files.some((f) => f.status !== "removed" && isWorkFile(f.filename))) return false;
  const tree = await githubRequest<{ tree: Array<{ path: string; type: string }>; truncated: boolean }>(
    `${base}/git/trees/${memory}?recursive=1`,
    { token },
  );
  return !tree.truncated && !tree.tree.some((entry) => entry.type === "blob" && isWorkFile(entry.path));
}

async function exists(root: string, name: string): Promise<boolean> {
  return access(join(root, name)).then(
    () => true,
    () => false,
  );
}

/**
 * Run an overview job: the agent over the main branch, findings reconciled as if merged, new
 * notes, the memory moved to the reviewed commit and the issue updated. A failed run is
 * recorded with what it spent and thrown for the queue to retry.
 */
export async function executeOverviewJob(job: ReviewJob, cacheOnly = false): Promise<OverviewJobResult> {
  const project = getProject(job.projectId);
  if (!project) throw new Error(`Project ${job.projectId} not found`);
  const installationId = await getRepoInstallationId(project.owner, project.repo);
  async function deliver(id: number, sha: string, recover: boolean) {
    const publication = stagedJobPublication(job.id);
    if (publication?.analysisId !== id || publication.key !== sha) throw new Error("Overview publication changed before delivery");
    return deliverStagedOverview(job.id, installationId, recover);
  }
  const staged = stagedJobPublication(job.id);
  if (staged) {
    const publication = await deliver(staged.analysisId, staged.key, true);
    return { quality: "complete", analysisId: staged.analysisId, publication };
  }
  const headSha = await defaultBranchHead(project, installationId);

  const prId = job.prId;
  const prior = selectPriorFindings(loadOpenFindings(prId), 0);
  const dismissed = selectDismissedFindings(loadDismissedFindings(prId), new Set());
  const notes = getProjectNotes(project.id);
  const payload = job.payload as OverviewPayload & { initialMapMode?: "parts" | "snapshot" | "agent" };
  const configuredMapMode = process.env.INITIAL_OVERVIEW_MODE;
  const rebuildMap = (payload.reason === "manual" || payload.reason === "merge") && configuredMapMode === "parts";
  const initialMapMode = payload.initialMapMode ?? (rebuildMap ? "parts"
    : payload.reason === "initial" && !notes && !getMemorySha(project.id) && configuredMapMode !== "agent"
      ? configuredMapMode === "parts" ? "parts" : "snapshot" : "agent");
  if (!payload.initialMapMode) getDb().prepare("UPDATE review_jobs SET payload=json_set(payload,'$.initialMapMode',?) WHERE id=?").run(initialMapMode, job.id);
  const snapshotMode = initialMapMode !== "agent";
  type Checkpoint = { version?: 1; policy?: string; sha: string; spent: number; evidence: string; research?: ResearchState; budget?: ExecutionBudgetSnapshot };
  const previous = (job.payload as OverviewPayload & { checkpoint?: Checkpoint }).checkpoint;
  if (previous && previous.sha !== headSha) {
    recordJobEvent(job.id, { type: "job_finished", reason: "superseded", oldSha: previous.sha, headSha });
    return { quality: "failed", reason: "superseded" };
  }
  const checkpoint = previous && previous.policy !== SNAPSHOT_POLICY_VERSION ? { ...previous, evidence: "", research: undefined } : previous;
  const used = checkpoint?.spent ?? 0;
  const priorBudget = checkpoint?.budget;
  const interruptedCalls = priorBudget?.calls.filter(call => call.status === "started") ?? [];
  const cacheMaximum = Math.max(1, (priorBudget?.spent.input ?? used) + (priorBudget?.spent.output ?? 0) + (priorBudget?.unknownTokens ?? 0));
  let configuredMaximum: number;
  try { configuredMaximum = overviewTokenLimit(); } catch { throw blockedPipelineConfiguration(job.id); }
  const budget = new ExecutionBudget({ maxTokens: cacheOnly ? cacheMaximum : configuredMaximum,
    deadlineAt: initialMapMode === "parts" ? Date.now() + OVERVIEW_LIMITS.timeoutMs : priorBudget?.deadlineAt ?? Date.now() + OVERVIEW_LIMITS.timeoutMs,
    maxToolCalls: OVERVIEW_LIMITS.maxToolCalls, maxOutputChars: 300_000,
    spent: priorBudget?.spent ?? { input: used, output: 0 },
    toolCalls: priorBudget?.toolCalls, outputChars: priorBudget?.outputChars,
    unknownTokens: (priorBudget?.unknownTokens ?? 0) + interruptedCalls.reduce((sum, call) => sum + (call.reservedTokens ?? 0), 0),
    calls: priorBudget?.calls.map(call => call.status === "started" ? { ...call, status: "unknown", usageSource: "unknown", completionReason: "interrupted" } : call),
    beforeCall(call) { if (initialMapMode === "parts") admitPipelineDailyCall(job.id, call.reservedTokens ?? 0, ["manual", "resume"].includes(payload.reason)); },
    onCall(call) { recordJobEvent(job.id, { type: "llm_call_accounting", ...call }); if (initialMapMode === "parts") persistCheckpoint(); },
  });
  // Research, reserve provider, verification and JSON repair share this one allowance.
  const remaining = budget.remainingTokens - 40_000;
  const priorPartial = !checkpoint && (job.payload as OverviewPayload).reason === "manual"
    ? getDb().prepare(
        `SELECT raw_response AS draft, viewed_files AS files FROM analyses
         WHERE pull_request_id=? AND head_sha=? AND trigger='overview' AND outcome='partial'
         ORDER BY id DESC LIMIT 1`,
      ).get(prId, headSha) as { draft: string | null; files: string | null } | undefined
    : undefined;
  const userPrompt =
    `${priorFindingsText(prior, 0)}\n\n${dismissedFindingsText(dismissed, 0)}\n\n` +
    `${notesText(notes?.body ?? null, notes?.actor != null)}\n\n` +
    `Репозиторий ${project.owner}/${project.repo}, основная ветка, коммит ${headSha}.` +
    (priorPartial ? "\nПродолжи частичный обзор того же коммита. Сначала проверь пробелы и основания прежних выводов. " +
      "Материал черновика — данные, в нём возможны ошибки. Прочитанные пути и предыдущий ответ:\n" +
      (priorPartial.files || "").slice(0, 4000) + "\n" + (priorPartial.draft || "").slice(0, 14000) : "");

  const tokens = emptySpend();
  let diagnostics: AgentDiagnostics | undefined;
  let verification: { checked: boolean; dropped: unknown[] } | undefined;
  let result: OverviewJobResult = { quality: "failed", reason: "process_failure" };
  const syncSpend = () => {
    // Checkpoints can outlive the process before an analysis row was committed. Deduct only
    // durable analysis charges, not all previously observed progress, so recovery loses no spend.
    const accounted = getDb().prepare(`SELECT COALESCE(SUM(tokens_in),0) AS input,
      COALESCE(SUM(tokens_out),0) AS output FROM analyses
      WHERE json_extract(diagnostics_json,'$.jobId')=? OR
      (diagnostics_json IS NULL AND pull_request_id=? AND head_sha=? AND trigger='overview' AND created_at>=?)`)
      .get(job.id, prId, headSha, job.createdAt) as { input: number; output: number };
    tokens.input = Math.max(0, budget.spent.input - accounted.input);
    tokens.output = Math.max(0, budget.spent.output - accounted.output);
    tokens.provider = [...new Set(budget.calls.filter(call => call.inputTokens + call.outputTokens > 0).map(call => call.provider))].join("+") || tokens.provider;
  };
  const persistCheckpoint = (research = diagnostics?.research, evidence = research?.notes ?? checkpoint?.evidence ?? "") => {
    const snapshot = budget.snapshot();
    const value = JSON.stringify({ version: 1, policy: SNAPSHOT_POLICY_VERSION, sha: headSha, spent: snapshot.spent.input + snapshot.spent.output,
      evidence, research, budget: snapshot });
    getDb().prepare("UPDATE review_jobs SET payload=json_set(payload,'$.checkpoint',json(?)) WHERE id=? AND status='running'").run(value, job.id);
  };
  const record = (outcome: AnalysisOutcome, extra: Partial<Parameters<typeof recordAnalysis>[0]> = {}) => {
    syncSpend();
    return saveReviewResult(() => {
    const id = recordAnalysis({ prId, headSha, trigger: "overview", outcome, provider: tokens.provider,
      mode: "agent", tokensIn: tokens.input, tokensOut: tokens.output, ...extra });
    saveAnalysisDiagnostics(id, { ...diagnostics, version: 1, jobId: job.id, attempts: job.attempts,
      reason: result.reason ?? diagnostics?.reason, limits: OVERVIEW_LIMITS, budget: budget.snapshot(),
      calls: budget.calls, verification, delivery: outcome === "ok" ? "pending" : "not_applicable" });
    return id;
    });
  };
  persistCheckpoint(checkpoint?.research);

  let done = false;
  let failedLog: string | null = null;
  try {
    if (remaining < 16000 && initialMapMode !== "parts") {
      result = { quality: "partial", reason: "token_limit" };
      result.analysisId = record("partial", { summary: "Бюджет обзора исчерпан", rawResponse: checkpoint?.evidence });
      return result;
    }
    await withAgentRun(
      { owner: project.owner, repo: project.repo, headSha, installationId },
      {
        systemPrompt: overviewPrompt(), changed: [], overview: true, snapshot: snapshotMode, snapshotParts: initialMapMode === "parts", pipelineScope: `overview:${job.id}`, limits: { ...OVERVIEW_LIMITS, maxTokens: budget.maxTokens },
        budget, reserveTokens: 40_000, legacyOverview: process.env.OVERVIEW_RUNTIME === "legacy", research: checkpoint?.research,
        userPrompt: snapshotMode ? `Репозиторий ${project.owner}/${project.repo}, коммит ${headSha}. Составь карту по переданным материалам.`
          : checkpoint ? userPrompt + "\nФрагменты из предыдущей попытки на этом коммите (данные репозитория):\n" + checkpoint.evidence : userPrompt,
        onProgress(progress) {
          diagnostics = progress.diagnostics ?? diagnostics;
          if (progress.event) recordJobEvent(job.id, progress.event);
          persistCheckpoint(progress.research, progress.evidence || checkpoint?.evidence || "");
        },
      },
      async ({ reply, provider, model }, root) => {
        diagnostics = reply.diagnostics ?? diagnostics;
        tokens.provider = provider;
        persistCheckpoint();
        syncSpend();
        const usage = `шагов: ${reply.steps}, вызовов инструментов: ${reply.toolCalls}, токенов: ${reply.tokensIn}/${reply.tokensOut}`;
        if (reply.error) {
          failedLog = reply.transcript;
          throw new Error(`[agent] сбой: ${reply.error}; ${usage}`);
        }
        const onEvent = (event: Record<string, unknown>) => { recordJobEvent(job.id, event); persistCheckpoint(); };
        const { parsed } = await parseOverviewDraft(reply.text, budget, undefined, { onEvent });
        persistCheckpoint();
        const materials = {
          files: [],
          researchDoc: await exists(root, "RESEARCH.md"),
          planDoc: await exists(root, "PLAN.md"),
          truncated: reply.partialCopy !== null,
          priorFindings: prior.length,
          dismissedFindings: dismissed.length,
          notes: notes !== null,
          studentResponses: 0,
        };
        const base = { model: `${model} (${snapshotMode ? "snapshot" : "agent"})`, materials, viewedFiles: reply.viewed, agentLog: reply.transcript };
        const invalidReconciliation = parsed?.findings.some(finding => finding.priorId !== null &&
          ((!prior.some(known => known.id === finding.priorId) && !dismissed.some(known => known.id === finding.priorId)) ||
           (finding.status === "closed" && !prior.some(known => known.id === finding.priorId)) ||
           (finding.status === "reopened" && !dismissed.some(known => known.id === finding.priorId))));
        if (!parsed || invalidReconciliation || (snapshotMode && parsed.findings.length !== 0)) {
          // Kept for the supervisor; not retried, a new run would cost as much again.
          result = { quality: "invalid", reason: "invalid_format" };
          result.analysisId = record("parse_error", { ...base, rawResponse: `${reply.text}\n\n[agent] ${usage}` });
          return;
        }
        if (reply.partialReview || reply.partialCopy) {
          result = { quality: "partial", reason: reply.partialCopy ? "incomplete_snapshot" : diagnostics?.reason ?? "incomplete_snapshot" };
          const id = record("partial", { ...base, summary: parsed.summary, rawResponse: reply.text });
          result.analysisId = id;
          if (parsed.notes) setAnalysisComment(id, parsed.notes);
          return;
        }
        const verified = await verifyFindings(parsed, root, undefined, { budget, onEvent });
        verification = { checked: verified.checked, dropped: verified.dropped };
        persistCheckpoint();
        result = { quality: "complete", reason: "completed" };
        const trailer = [
          `[agent] ${usage}`,
          `[agent] прочитано: ${reply.viewed.join(", ") || "—"}`,
          ...(reply.partialCopy ? [`[agent] копия неполная: ${reply.partialCopy}`] : []),
          ...verified.dropped.map((d) => `[verify] отброшено: ${d.title} — ${d.reason}`),
        ];
        const saved = saveReviewResult(() => {
          const analysisId = record("ok", {
            ...base,
            summary: parsed.summary || null,
            rawResponse: `${reply.text}\n\n${trailer.join("\n")}`,
          });
          applyReconciliation(prId, analysisId, verified.result, {
            allowedPriorIds: new Set(prior.map((f) => f.id)),
            reopenableIds: new Set(dismissed.map((f) => f.id)),
            allowNew: true,
            fixesFinal: true,
            wholeRepository: true,
            changed: new Map(),
          });
          // Notes edited meanwhile (by a supervisor or a merged PR) are not overwritten.
          let publicationNotesId = notes?.id ?? null;
          if (parsed.notes && (!snapshotMode || notes?.actor == null) && (getProjectNotes(project.id)?.id ?? null) === (notes?.id ?? null)) {
            addProjectNotes(project.id, parsed.notes, { analysisId, strict: initialMapMode === "parts" });
            publicationNotesId = getProjectNotes(project.id)?.id ?? null;
          }
          stageJobPublication(job.id, analysisId, headSha,
            overviewIssueBody(project.id, { sha: headSha, body: snapshotMode && notes?.actor != null ? notes.body : parsed.notes || "" }),
            { notesId: publicationNotesId });
          if (initialMapMode === "parts" && diagnostics?.snapshot?.included) {
            saveProjectMap(project.id, job.id, analysisId, headSha, parsed.notes || "", {
              version: SNAPSHOT_POLICY_VERSION,
              included: diagnostics.snapshot.included, excluded: diagnostics.snapshot.excluded,
            }, payload.reason === "initial" || payload.reason === "manual");
          }
          return analysisId;
        });
        result.analysisId = saved;
        result.publication = await deliver(saved, headSha, false);
        saveAnalysisDiagnostics(saved, { ...diagnostics, version: 1, jobId: job.id, attempts: job.attempts, reason: "completed",
          limits: OVERVIEW_LIMITS, budget: budget.snapshot(), calls: budget.calls, verification, delivery: result.publication });
        done = true;
      },
    );
  } catch (error) {
    if (done) {
      console.warn(`[overview] ${project.owner}/${project.repo}: cleanup after a saved overview failed:`, error);
      return result;
    }
    persistCheckpoint();
    if (stagedJobPublication(job.id)) throw error;
    result = { quality: "failed", reason: error instanceof ExecutionBudgetError || error instanceof AgentProcessError
      ? error.reason : diagnostics?.reason ?? "process_failure" };
    if (initialMapMode === "parts") {
      const failure = pipelineFailure(error);
      const wait = cacheOnly && failure.reason === "token_limit" ? new PipelineWaitError("daily_tokens", "retryable") : failure;
      patchPipelineJob(job.id, { quality: "not_reviewed", recovery: wait.recovery, reason: wait.reason, configuration: pipelineConfigurationFingerprint() });
      record("error", { rawResponse: error instanceof Error ? error.message : String(error), agentLog: failedLog });
      throw wait;
    }
    if (job.attempts >= 2) {
      const retained = getDb().prepare("SELECT json_extract(payload,'$.checkpoint.evidence') AS evidence FROM review_jobs WHERE id=?").get(job.id);
      if (typeof retained?.evidence === "string" && retained.evidence.length > 2) {
        result.quality = "partial";
        const id = record("partial", { summary: "Не удалось завершить обзор. Сохранены материалы чтения.",
          rawResponse: retained.evidence, agentLog: failedLog });
        setAnalysisComment(id, retained.evidence);
        result.analysisId = id;
        return result;
      }
    }
    syncSpend();
    record("error", { rawResponse: error instanceof Error ? error.message : String(error), agentLog: failedLog });
    throw error;
  }
  return result;
}

/**
 * The issue text: how the curator understands the project. Findings stay in the PR comments,
 * so the issue changes only with the notes.
 */
function overviewIssueBody(projectId: number, snapshot?: { sha: string | null; body: string }): string {
  const notes = snapshot ? snapshot.body : getProjectNotes(projectId)?.body;
  const sha = snapshot ? snapshot.sha : getMemorySha(projectId);
  return [
    "🤖 **AI Curator — как куратор понимает проект**",
    "",
    `Описание составлено по основной ветке${sha ? ` (коммит \`${sha.slice(0, 7)}\`)` : ""}. ` +
      "Куратор опирается на него при разборе pull request; оно обновляется при полном обзоре " +
      "проекта и при правке руководителем.",
    "",
    "**Если здесь что-то неверно, напишите руководителю проекта** — он исправит описание в " +
      "панели куратора. Комментарии в этом issue куратор не читает. Замечания куратора — в " +
      "комментариях к pull request.",
    "",
    "## Как устроен проект",
    "",
    notes ? publicText(notes) : "_Описания пока нет._",
    "",
    `_Обновлено ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" }).format(new Date())}_`,
    `<!-- ai-curator-overview:${projectId} -->`,
  ].join("\n");
}

/** Deliver the saved body verbatim; newer notes supersede only delivery, never accepted memory. */
export async function deliverStagedOverview(jobId: number, installationId: number, recover = true): Promise<"delivered" | "superseded"> {
  const staged = stagedJobPublication(jobId);
  if (!staged) throw new Error("No staged overview publication");
  const row = getDb().prepare(
    "SELECT pr.project_id AS projectId FROM review_jobs j JOIN pull_requests pr ON pr.id=j.pull_request_id WHERE j.id=?",
  ).get(jobId) as { projectId: number };
  const project = getProject(row.projectId);
  if (!project) throw new Error("Overview project not found");
  // A full analysis is accepted independently of whether its issue body is still current.
  await coverMemory(project, staged.key, installationId);
  const body = staged.snapshot?.version === 1 ? staged.body
    : overviewIssueBody(project.id, { sha: staged.key, body: staged.body });
  const setDelivery = (state: string, error?: string) => {
    const delivery = { state, ...(error ? { error } : {}) };
    saveAnalysisDiagnostics(staged.analysisId, { version: 1, ...getAnalysisDiagnostics(staged.analysisId), delivery });
    recordJobEvent(jobId, { type: "publication_finished", analysisId: staged.analysisId, ...delivery });
  };
  // A manual edit can finish publishing while an older PATCH is in flight. Persist a
  // separate follow-up snapshot so a failed repair retries without changing analysis history.
  const repairLatestNotes = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const notes = getProjectNotes(project.id);
      const notesId = notes?.id ?? null;
      const pending = getDb().prepare(
        "SELECT json_extract(payload,'$.publicationRepair') AS repair FROM review_jobs WHERE id=?",
      ).get(jobId)?.repair;
      const previous = typeof pending === "string" ? JSON.parse(pending) as { notesId: number | null; body: string } : null;
      const repair = previous?.notesId === notesId ? previous : { notesId,
        body: overviewIssueBody(project.id, { sha: getMemorySha(project.id), body: notes?.body ?? "" }) };
      getDb().prepare("UPDATE review_jobs SET payload=json_set(payload,'$.publicationRepair',json(?)) WHERE id=?").run(JSON.stringify(repair),jobId);
      recordJobEvent(jobId, { type: "publication_repair_started", notesId });
      const repaired = await publishOverviewIssue(project.id, installationId, true, repair.body);
      if (repaired.error) {
        setDelivery("failed", repaired.error);
        throw new Error("Latest notes publication repair failed: " + repaired.error);
      }
      if ((getProjectNotes(project.id)?.id ?? null) === notesId) {
        getDb().prepare("UPDATE review_jobs SET payload=json_remove(payload,'$.publicationRepair') WHERE id=?").run(jobId);
        recordJobEvent(jobId, { type: "publication_repair_finished", notesId });
        return;
      }
    }
    throw new Error("Notes kept changing during publication; latest snapshot remains queued");
  };
  if (staged.snapshot?.version === 1 && (getProjectNotes(project.id)?.id ?? null) !== staged.snapshot.notesId) {
    setAnalysisComment(staged.analysisId, body);
    const pendingRepair = getDb().prepare("SELECT json_type(payload,'$.publicationRepair') AS repair FROM review_jobs WHERE id=?").get(jobId)?.repair;
    if (pendingRepair === "object") await repairLatestNotes();
    setDelivery("superseded");
    return "superseded";
  }
  recordJobEvent(jobId, { type: "publication_started", analysisId: staged.analysisId });
  const published = await publishOverviewIssue(project.id, installationId, recover, body);
  // Keep the historical snapshot even if the HTTP response is lost.
  setAnalysisComment(staged.analysisId, body);
  if (published.error) {
    setDelivery("failed", published.error);
    throw new Error("Overview publication failed: " + published.error);
  }
  if (staged.snapshot?.version === 1 && (getProjectNotes(project.id)?.id ?? null) !== staged.snapshot.notesId) {
    await repairLatestNotes();
    setDelivery("superseded");
    return "superseded";
  }
  setDelivery("delivered");
  return "delivered";
}

/**
 * Create or update the project's overview issue. A failure (no permission, issues disabled) is
 * not thrown: the overview is saved anyway, and the returned body says it was not published.
 */
export async function publishOverviewIssue(
  projectId: number,
  installationId?: number,
  recover = false,
  savedBody?: string,
): Promise<{ body: string; error: string | null }> {
  const body = savedBody ?? overviewIssueBody(projectId);
  const project = getProject(projectId);
  if (!project) return { body, error: "project not found" };
  try {
    const token = await getInstallationToken(installationId ?? (await getRepoInstallationId(project.owner, project.repo)));
    const base = `/repos/${project.owner}/${project.repo}/issues`;
    let existing = getOverviewIssue(projectId);
    if (recover && existing === null) {
      // A timed-out POST may already have created the issue. Only adopt this app's issue.
      const appId = getConfig().appId;
      for (let page = 1; ; page++) {
        const issues = await githubRequest<Array<{ number: number; title: string; body?: string; performed_via_github_app?: { id: number } }>>(
          `${base}?state=all&per_page=100&page=${page}`, { token });
        const match = issues.find(i => String(i.performed_via_github_app?.id) === String(appId) &&
          (i.body?.includes(`<!-- ai-curator-overview:${projectId} -->`) || i.title === ISSUE_TITLE));
        if (match) { existing = match.number; setOverviewIssue(projectId, existing); break; }
        if (issues.length < 100) break;
      }
    }
    if (existing !== null) {
      try {
        await githubRequest(`${base}/${existing}`, {
          method: "PATCH",
          token,
          body: { title: ISSUE_TITLE, body, state: "open" },
        });
        return { body, error: null };
      } catch (error) {
        // A deleted issue is created anew; anything else is a real failure.
        if (!(error instanceof Error && / failed: (404|410) /.test(error.message))) throw error;
      }
    }
    const issue = await githubRequest<{ number: number }>(base, {
      method: "POST",
      token,
      body: { title: ISSUE_TITLE, body },
    });
    setOverviewIssue(projectId, issue.number);
    // Comments go to the supervisor, not here: the curator does not read this issue.
    await githubRequest(`${base}/${issue.number}/lock`, { method: "PUT", token }).catch((error) =>
      console.warn(`[overview] failed to lock issue #${issue.number}:`, error),
    );
    return { body, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[overview] issue of ${project.owner}/${project.repo} not published:`, message);
    return { body: `_Не опубликовано в GitHub: ${message.slice(0, 300)}_\n\n${body}`, error: message };
  }
}
