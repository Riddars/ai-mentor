import { LlmRequestError } from "@/lib/llm/chat";
import { automaticallyRetryExecution, ExecutionBudgetError } from "@/lib/llm/execution";
import { hashText } from "./context-parts";
import type { ContextLimits } from "./context-size";
import { collectPrEvidence, renderPrEvidence, type EvidenceIssue } from "./pr-evidence";
import { prContextVerifyPrompt } from "./prompts";
import type { PrNode, PrPipelineOptions } from "./pr-pipeline";
import type { ReconciledFinding } from "./store";
import type { ReadWholeFileResult } from "@/lib/agent/whole-file-reader";
import { repairSchema } from "./schema-repair";

function decodeVerdicts(raw: string, ids: string[]) {
  try {
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")) as { verdicts: Array<{ id: string; status: string; reason: string }> };
    return Array.isArray(value.verdicts) && value.verdicts.length === ids.length && new Set(value.verdicts.map(v => v.id)).size === ids.length &&
      value.verdicts.every(v => ids.includes(v.id) && ["confirmed", "refuted", "unresolved"].includes(v.status) && typeof v.reason === "string" && v.reason.trim() && v.reason.length <= 1000)
      ? value.verdicts : null;
  } catch { return null; }
}

export async function verifyPrNode(node: PrNode, options: PrPipelineOptions, limits: ContextLimits, futureReserve: number, planning = false) {
  const unresolved: string[] = [], verified: string[] = [], rejected: string[] = [], kept: ReconciledFinding[] = [];
  const decisions: Array<{ id: string; status: "confirmed" | "refuted" | "unresolved"; finding: ReconciledFinding }> = [];
  const issues: EvidenceIssue[] = [], evidenceRecords: Array<{ id: string; hash: string }> = [];
  const proofs: Array<{ id: string; ranges: Array<{ source: string; from: number; to: number }>; files: ReadWholeFileResult[] }> = [];
  let cost = 0;
  const candidates = new Map(node.answer.candidates.map(candidate => [
    hashText(JSON.stringify([options.repository.head,
      [...(candidate.finding.locations ?? [])].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), candidate.rootCause.trim()])), candidate,
  ] as const));
  const verifyLimits = { ...limits, outputTokens: Math.min(2000, limits.outputTokens) };
  const batch = async (ids: string[]): Promise<void> => {
    if (!ids.length) return;
    const active = ids.map(id => ({ id, ...candidates.get(id)! }));
    const evidence = await collectPrEvidence(node, active.flatMap(c => c.finding.locations ?? []), active.flatMap(c => c.sourceIds),
      options.repository, verifyLimits, options.budget, futureReserve, proof => [
        { role: "system", content: prContextVerifyPrompt() },
        { role: "user", content: JSON.stringify({ candidates: active.map(c => ({ id: c.id, finding: c.finding })) }) + "\nИсходные материалы:\n" + renderPrEvidence(proof) },
      ], planning);
    if (evidence.issues.length) {
      if (ids.length > 1) { const middle = Math.ceil(ids.length / 2); await batch(ids.slice(0, middle)); await batch(ids.slice(middle)); }
      else { issues.push(...evidence.issues); unresolved.push(`${active[0].finding.title}: ${evidence.issues.map(i => i.reason).join(", ")}`); }
      return;
    }
    const key = hashText(JSON.stringify(evidence.messages)), cacheId = "pr-verify-batch:" + hashText(ids.join(","));
    let answer = options.store!.load(cacheId, key);
    if (!answer && planning) { cost += evidence.measurement.required; return; }
    if (!answer) {
      if (evidence.measurement.required + futureReserve > options.budget.remainingTokens) {
        issues.push({ reason: "token_limit", retryable: false, detail: "Verification must preserve remaining planned work" });
        unresolved.push(...active.map(c => `Проверка ожидает бюджета: ${c.finding.title}`)); return;
      }
      try {
        answer = await options.ask!(evidence.messages, { budget: options.budget, phase: "verify", maxOutputTokens: verifyLimits.outputTokens,
          reserveTokens: futureReserve, contextTokens: limits.contextTokens, fallbackContextTokens: options.fallback?.contextTokens });
      } catch (error) {
        const reason = error instanceof ExecutionBudgetError || error instanceof LlmRequestError ? error.reason : "process_failure";
        const retryable = error instanceof LlmRequestError ? error.retryable : automaticallyRetryExecution(reason);
        issues.push({ reason, retryable, detail: `Independent verification: ${reason}` });
        options.onEvent?.({ type: "pr_verification_failed", reason, retryable, candidates: ids });
        unresolved.push(...active.map(c => `Проверка не выполнена (${reason}): ${c.finding.title}`)); return;
      }
    }
    let verdicts = decodeVerdicts(answer.content, ids);
    if (!planning) {
      options.store!.save(cacheId, key, answer);
      try {
        const repair = await repairSchema(answer, raw => decodeVerdicts(raw, ids), { id: cacheId, hash: key, schema: prContextVerifyPrompt() + "\nРовно один verdict для каждого id: " + JSON.stringify(ids),
          limits: verifyLimits, budget: options.budget, reserve: futureReserve, store: options.store!, ask: options.ask!, fallbackContextTokens: options.fallback?.contextTokens });
        verdicts = repair.value; answer = repair.answer;
      } catch (error) {
        const reason = error instanceof ExecutionBudgetError || error instanceof LlmRequestError ? error.reason : "process_failure";
        issues.push({ reason, retryable: error instanceof LlmRequestError ? error.retryable : automaticallyRetryExecution(reason), detail: "Verifier format repair did not finish" });
        unresolved.push(...active.map(c => `Не завершено исправление проверки: ${c.finding.title}`)); return;
      }
    }
    try {
      if (!verdicts) throw new Error("Invalid verifier schema");
      if (!planning) options.store!.save(cacheId, key, answer);
      evidenceRecords.push({ id: cacheId, hash: key });
      for (const verdict of verdicts) {
        proofs.push({ id: verdict.id, ranges: evidence.units.map(u => ({ source: u.source.id, from: u.from, to: u.to })), files: evidence.files });
        decisions.push({ id: verdict.id, status: verdict.status as "confirmed" | "refuted" | "unresolved", finding: candidates.get(verdict.id)!.finding });
        if (verdict.status === "confirmed") { kept.push(candidates.get(verdict.id)!.finding); verified.push(verdict.id); }
        else if (verdict.status === "refuted") rejected.push(verdict.id);
        else unresolved.push(`${candidates.get(verdict.id)!.finding.title}: ${verdict.reason}`);
      }
    } catch { issues.push({ reason: "invalid_format", retryable: false, detail: "Invalid verifier response" }); unresolved.push(...active.map(c => `Не удалось разобрать проверку: ${c.finding.title}`)); }
  };
  await batch([...candidates.keys()]);
  for (const [id, candidate] of candidates) if (!decisions.some(d => d.id === id)) decisions.push({ id, status: "unresolved", finding: candidate.finding });
  return { kept, verified, rejected, unresolved, decisions, issues, evidenceRecords, proofs, cost };
}
