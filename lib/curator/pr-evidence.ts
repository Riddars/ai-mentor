import type { ChatMessage } from "@/lib/llm/chat";
import { ExecutionBudget } from "@/lib/llm/execution";
import { createWholeFileReader, type ReadWholeFileResult } from "@/lib/agent/whole-file-reader";
import type { FindingLocation } from "./finding";
import { sourceUnit, unitText, type SourceUnit } from "./context-parts";
import { measureContext, type ContextLimits } from "./context-size";
import { diffRangeMetadata, type DiffSource, type ReviewRepository } from "./pr-full-diff";
import { lineRange } from "./scope";
const LINE_REFERENCE = /^(?:(?:строк[аи]?|стр\.?|lines?)\s*)?\d+(?:\s*[-–—]\s*\d+)?$/i;
const citedRange = (location: FindingLocation) => LINE_REFERENCE.test(location.detail?.trim() ?? "") ? lineRange(location.detail) : null;

export interface EvidenceIssue { reason: string; retryable: boolean; detail: string }
export interface EvidenceOwner { units: SourceUnit[]; files: ReadWholeFileResult[]; refs?: Record<string, string[]>; fullEvidence?: boolean }
export interface EvidenceProof { revisions: { base: string; head: string }; diff: Array<{ metadata: ReturnType<typeof diffRangeMetadata>; text: string }>; files: ReadWholeFileResult[] }
export function renderPrEvidence(proof: EvidenceProof): string {
  return "Версии: " + JSON.stringify(proof.revisions) + "\n" + proof.diff.map(d =>
    "=== DIFF " + JSON.stringify(d.metadata) + " ===\n" + d.text + "\n=== END DIFF ===").join("\n") + "\n" + proof.files.map(file => {
      const { text, ...metadata } = file;
      return "=== WHOLE FILE " + JSON.stringify(metadata) + " ===\n" + text + "\n=== END FILE ===";
    }).join("\n");
}
/** Shared by new candidates and former findings; diff selection is not clipped file reading. */
export async function collectPrEvidence(owner: EvidenceOwner, locations: FindingLocation[], sourceIds: string[],
  repository: ReviewRepository, limits: ContextLimits, budget: ExecutionBudget, reserve: number,
  template: (proof: EvidenceProof) => ChatMessage[], planning = false) {
  const issues: EvidenceIssue[] = [];
  for (const location of locations) if (LINE_REFERENCE.test(location.detail?.trim() ?? "") && !lineRange(location.detail)) {
    issues.push({ reason: "invalid_citation", retryable: false, detail: `${location.target}: invalid numeric line reference` });
  }
  const paths = new Set(locations.filter(l => l.kind !== "other").map(l => l.target));
  const revision = (path: string): "head" | "base" => repository.changes.some(c => c.oldPath === path && (c.status === "D" || c.oldPath !== c.newPath)) ? "base" : "head";
  const numberAt = (source: DiffSource, line: typeof source.lines[number], path: string) => revision(path) === "base" ? line.oldLine : line.newLine;
  const sourcePaths = (source: DiffSource, path: string) => source.path === path || source.change.oldPath === path;
  const triggers = new Set(sourceIds.flatMap(id => paths.size && owner.refs?.[id] ? [] : owner.refs?.[id] ?? [id]));
  const selected: SourceUnit[] = [];
  for (const unit of owner.units) {
    const source = unit.source as DiffSource;
    const cited = locations.filter(l => l.kind !== "other" && sourcePaths(source, l.target));
    if (owner.fullEvidence || (!cited.length && triggers.has(source.id))) { selected.push(unit); continue; }
    for (const location of cited) {
      const range = citedRange(location);
      if (!range || !source.hunks.length) { selected.push(unit); continue; }
      for (let i = 0; i < source.hunks.length; i++) {
        const from = Math.max(unit.from, source.hunks[i]), to = Math.min(unit.to, source.hunks[i + 1] ?? source.bytes);
        if (from >= to) continue;
        if (source.lines.some(line => { const n = numberAt(source, line, location.target);
          return n !== null && n >= range.from && n <= range.to && line.to > from && line.from < to; })) selected.push(sourceUnit(source, from, to));
      }
    }
  }
  const units = [...new Map(selected.map(u => [u.id, u])).values()];
  const files = new Map(owner.files.filter(f => f.status === "ok" && typeof f.text === "string" &&
    f.sha === (f.revision === "head" ? repository.head : repository.mergeBase))
    .map(f => [JSON.stringify([f.path, f.revision]), f]));
  const diff = await Promise.all(units.map(async u => ({ metadata: diffRangeMetadata(u), text: await unitText(u) })));
  const proof = (): EvidenceProof => ({ revisions: { base: repository.mergeBase, head: repository.head }, diff, files: [...files.values()] });
  const messages = () => template(proof());
  if (!measureContext(messages(), limits).fits) issues.push({ reason: "context_limit", retryable: false, detail: "Evidence bundle exceeds context" });
  const reader = createWholeFileReader({ repository, limits, available: files, completionRequests: 1,
    budget: planning ? new ExecutionBudget({ maxTokens: Number.MAX_SAFE_INTEGER, deadlineAt: budget.deadlineAt }) : budget,
    futureReserve: () => planning ? 0 : reserve,
    withResult: candidate => template({ ...proof(), files: [...files.values(), candidate] }) });
  if (!issues.length) for (const path of [...paths].sort()) {
    const relevant = locations.filter(l => l.kind !== "other" && l.target === path);
    let need = false;
    for (const location of relevant) {
      const range = citedRange(location);
      if (!range) { need = true; continue; }
      const covered = new Set<number>();
      for (const unit of units) {
        const source = unit.source as DiffSource;
        if (!sourcePaths(source, path)) continue;
        for (const line of source.lines) { const n = numberAt(source, line, path);
          if (n !== null && n >= range.from && n <= range.to && line.from >= unit.from && line.to <= unit.to) covered.add(n); }
      }
      if (covered.size !== range.to - range.from + 1) need = true;
    }
    const full = files.get(JSON.stringify([path, revision(path)]));
    if (need && !full) await reader.read(path, revision(path));
    const current = files.get(JSON.stringify([path, revision(path)]));
    if (current) for (const location of relevant) {
      const range = citedRange(location);
      if (range && range.to > current.text!.split("\n").length) issues.push({ reason: "invalid_citation", retryable: false, detail: `${path}: cited range is outside file` });
    }
  }
  for (const denied of reader.denied) issues.push({ reason: denied.reason?.includes("budget") ? "token_limit" : denied.reason?.includes("context") ? "context_limit" : "evidence_missing",
    retryable: false, detail: `${denied.path}: ${denied.reason}` });
  if (!units.length && !files.size) issues.push({ reason: "evidence_missing", retryable: false, detail: "No trusted source evidence" });
  const measurement = measureContext(messages(), limits);
  if (!measurement.fits && !issues.some(i => i.reason === "context_limit")) issues.push({ reason: "context_limit", retryable: false, detail: "Complete files exceed evidence context" });
  return { messages: messages(), units, files: [...files.values()], issues, measurement };
}
