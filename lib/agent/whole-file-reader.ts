import type { ReviewRepository } from "@/lib/curator/pr-full-diff";
import { reviewFileExclusion } from "@/lib/curator/snapshot-policy";
import { notebookCells } from "@/lib/curator/notebook";
import { measureContext, type ContextLimits } from "@/lib/curator/context-size";
import { ExecutionBudgetError, type ExecutionBudget } from "@/lib/llm/execution";

export const FILE_POLICY_DENIAL = "file policy: contents not transmitted";

export interface ReadWholeFileResult {
  status: "ok" | "denied" | "already_available";
  path: string;
  revision: "head" | "base";
  sha?: string;
  blob?: string;
  text?: string;
  reason?: string;
}
export interface WholeFileReaderOptions {
  repository: ReviewRepository;
  limits: ContextLimits;
  budget: ExecutionBudget;
  /** Exact next request candidate, with the prospective tool result included. */
  withResult(result: ReadWholeFileResult): unknown;
  futureReserve(): number;
  /** Agent exploration needs next answer + finalisation + verification; a fixed verifier needs one. */
  completionRequests?: number;
  available?: Map<string, ReadWholeFileResult>;
}
export function createWholeFileReader(options: WholeFileReaderOptions) {
  const available = options.available ?? new Map<string, ReadWholeFileResult>();
  let previous = "", repeats = 0, stalled = false;
  const denied: ReadWholeFileResult[] = [];
  return { available, denied, get stalled() { return stalled; },
    async read(path: string, revision: "head" | "base" = "head"): Promise<ReadWholeFileResult> {
      const key = JSON.stringify([path, revision]);
      if (key === previous) repeats++; else { previous = key; repeats = 1; }
      if (repeats >= 3) stalled = true;
      const refuse = (reason: string): ReadWholeFileResult => { const result: ReadWholeFileResult = { status: "denied", path, revision, reason };
        denied.push(result); return result; };
      if (stalled) return refuse("no_progress: repeated identical request; finish with explicit unresolved questions");
      if (typeof path !== "string" || !["head", "base"].includes(revision)) return refuse("invalid_request");
      const exclusion = reviewFileExclusion(path, options.repository.changes);
      if (exclusion) return refuse(`${FILE_POLICY_DENIAL} (${exclusion})`);
      const existing = available.get(key);
      if (existing) return { status: "already_available", path, revision, sha: existing.sha, blob: existing.blob, reason: "full file is already in this conversation" };
      let file;
      try { file = await options.repository.readFile(path, revision); }
      catch (error) { if (error instanceof ExecutionBudgetError) throw error; return refuse("file_unavailable_or_exceeds_safe_loading_limit"); }
      if (!file) return refuse("file_not_found_or_not_regular");
      let raw: string;
      try {
        if (file.bytes.includes(0)) throw new Error("binary");
        raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
      } catch { return refuse("binary_or_unsupported_encoding"); }
      if (/\.ipynb$/i.test(path)) {
        const cells = notebookCells(raw);
        if (cells === null) return refuse("invalid_notebook");
        raw = cells;
      }
      const result: ReadWholeFileResult = { status: "ok", path, revision, sha: file.revision, blob: file.blob, text: raw };
      if (!measureContext(options.withResult(result), options.limits).fits) return refuse("whole_file_exceeds_remaining_context");
      // Numbering is presentation, not clipping: every original line, including an empty final one.
      result.text = raw.split("\n").map((line, index) => `${index + 1}\t${line}`).join("\n");
      const measurement = measureContext(options.withResult(result), options.limits);
      if (!measurement.fits) return refuse("whole_numbered_file_exceeds_remaining_context");
      // Next answer, finalisation and independent verification all resend the accumulated context.
      const requests = options.completionRequests ?? 3;
      if (!Number.isSafeInteger(requests) || requests < 1) throw new Error("Invalid completion request reserve");
      const required = requests * measurement.required + options.futureReserve();
      if (required > options.budget.remainingTokens) return refuse("insufficient_budget_for_whole_file_and_completion");
      available.set(key, result);
      return result;
    } };
}
