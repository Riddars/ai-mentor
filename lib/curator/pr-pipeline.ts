import type { PrAgentTarget, PrAgentCheckpoint } from "@/lib/agent/pr-context-agent.mjs";
import type { ReadWholeFileResult } from "@/lib/agent/whole-file-reader";
import { chat, LlmRequestError, type ChatMessage, type ChatOptions, type ChatResult } from "@/lib/llm/chat";
import { ContextWindowError, ExecutionBudget, ExecutionBudgetError } from "@/lib/llm/execution";
import { FINDING_AREAS, LOCATION_KINDS, SEVERITIES, type FindingArea, type FindingLocation, type Severity } from "./finding";
import { hashText, packContext, rebuildPartRequest, sourceUnit, unitText, type ContextSource, type SourceUnit } from "./context-parts";
import { measureContext, type ContextLimits } from "./context-size";
import { diffRangeMetadata, splitDiffUnit, type ReviewRepository } from "./pr-full-diff";
import { memoryPipelineStore, type PipelineStore } from "./pipeline-store";
import { prContextPrompt, prContextVerifyPrompt } from "./prompts";
import { contextReplacements } from "./context-replacements";
import { repairSchema } from "./schema-repair";
import { verifyPrNode } from "./pr-verification";
import { buildPriorGroups, checkPriorGroups } from "./pr-prior";
import type { DismissedFinding, PriorFinding, ReconciledFinding, ReconcileResult, StudentResponse } from "./store";
import type { ChangedLines } from "./scope";

interface Candidate { finding: ReconciledFinding; sourceIds: string[]; rootCause: string }
interface PartAnswer { summary: string; changes: string; unresolved: string[]; refreshOverview: string | null; candidates: Candidate[] }
interface DescriptionBounds { summary: number; changes: number; question: number }
const DEFAULT_BOUNDS: DescriptionBounds = { summary: 1500, changes: 4000, question: 150 };
export interface PrNode { id: string; answer: PartAnswer; units: SourceUnit[]; files: ReadWholeFileResult[]; denied: ReadWholeFileResult[]; refs?: Record<string, string[]>; fullEvidence?: boolean; capabilityKey?: string }
type Node = PrNode;
export interface PrPipelineOptions {
  repository: ReviewRepository;
  context: string;
  primary: PrAgentTarget;
  fallback?: PrAgentTarget;
  budget: ExecutionBudget;
  store?: PipelineStore;
  ask?: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult>;
  onEvent?: (event: Record<string, unknown>) => void;
  outputTokens?: number;
  capabilityKey?: string;
  prior?: PriorFinding[];
  dismissed?: DismissedFinding[];
  responses?: StudentResponse[];
}
export interface PrPipelineResult {
  quality: "complete" | "limited";
  result: ReconcileResult;
  changed: ChangedLines;
  files: string[];
  diagnostics: Record<string, unknown>;
}
const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export function decodePrPart(raw: string, allowed: Set<string>, bounds = DEFAULT_BOUNDS): PartAnswer | null {
  try {
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")) as Record<string, unknown>;
    if (!obj(value) || !nonempty(value.summary) || value.summary.length > bounds.summary || !nonempty(value.changes) || value.changes.length > bounds.changes ||
      !Array.isArray(value.unresolved) || value.unresolved.length > 20 || !value.unresolved.every(s => nonempty(s) && s.length <= bounds.question) || !Array.isArray(value.findings) ||
      !(value.refresh_overview === null || (typeof value.refresh_overview === "string" && value.refresh_overview.length <= 500))) return null;
    const candidates: Candidate[] = [];
    for (const item of value.findings) {
      if (!obj(item) || item.prior_id !== null || item.status !== "open" ||
        !["title", "description", "evidence", "impact", "recommendation", "verify", "root_cause"].every(k => nonempty(item[k]) && (item[k] as string).length <= 4000) ||
        !FINDING_AREAS.includes(item.area as FindingArea) || !SEVERITIES.includes(item.severity as Severity) ||
        !Array.isArray(item.source_ids) || !item.source_ids.length || !item.source_ids.every(id => typeof id === "string" && allowed.has(id)) ||
        !Array.isArray(item.locations) || !item.locations.length || !item.locations.every(location => obj(location) &&
          LOCATION_KINDS.includes(location.kind as typeof LOCATION_KINDS[number]) && nonempty(location.target) && (location.detail === null || typeof location.detail === "string"))) return null;
      candidates.push({ sourceIds: item.source_ids as string[], rootCause: item.root_cause as string,
        finding: { priorId: null, status: "open", title: item.title as string, area: item.area as FindingArea, severity: item.severity as Severity,
          description: item.description as string, evidence: item.evidence as string, impact: item.impact as string,
          recommendation: item.recommendation as string, verify: item.verify as string, locations: item.locations as FindingLocation[] } });
    }
    return { summary: value.summary, changes: value.changes, unresolved: value.unresolved as string[], refreshOverview: value.refresh_overview as string | null, candidates };
  } catch { return null; }
}
function description(node: Node, revision: string): ContextSource {
  const allPaths = [...new Set(node.units.map(u => u.source.path))];
  const paths: string[] = [];
  let pathChars = 0;
  for (const path of allPaths) {
    const chars = JSON.stringify(path).length;
    if (paths.length < 40 && pathChars + chars <= 4000) { paths.push(path); pathChars += chars; }
  }
  const bytes = Buffer.from(JSON.stringify({ summary: node.answer.summary, changes: node.answer.changes, unresolved: node.answer.unresolved,
    paths, additionalPaths: allPaths.length - paths.length }));
  const viewHash = hashText(bytes), id = hashText(node.id + viewHash);
  return { id, path: "description:" + node.id, revision, kind: "description", bytes: bytes.length, originalHash: viewHash, viewHash,
    transformation: "pr-description-v1", read: async (from, to) => bytes.subarray(from, to) };
}
export async function runPrPipeline(options: PrPipelineOptions): Promise<PrPipelineResult> {
  const { runPrContextAgent } = await import("@/lib/agent/pr-context-agent.mts");
  const { repository, budget } = options;
  const store = options.store ?? memoryPipelineStore(), ask = options.ask ?? chat;
  const outputTokens = options.outputTokens ?? 8000;
  const limits: ContextLimits = { contextTokens: options.primary.contextTokens, outputTokens, safetyRatio: 0.15 };
  const emit = (event: Record<string, unknown>) => options.onEvent?.(event);
  const revision = JSON.stringify([repository.base, repository.mergeBase, repository.head]);
  const finalKey = hashText(JSON.stringify(["pr-final-v3.4", revision, repository.sources.map(s => [s.id, s.viewHash]), options.context,
    options.primary.provider, options.primary.model.id, options.primary.contextTokens, options.fallback?.provider,
    options.fallback?.model.id, options.fallback?.contextTokens, outputTokens, options.prior, options.dismissed, options.responses,
    prContextPrompt(false), prContextPrompt(true), prContextVerifyPrompt()]));
  const finished = store.load("pr-final", finalKey);
  if (finished) {
    const value = JSON.parse(finished.content) as Omit<PrPipelineResult, "changed"> & { changed: Array<[string, number[] | null]> };
    if (value.quality !== "complete" || !Array.isArray(value.changed) || !Array.isArray(value.result?.findings) || typeof value.result.summary !== "string") throw new Error("invalid_format: corrupt final PR checkpoint");
    emit({ type: "pr_final_reused", revision });
    return { ...value, changed: new Map(value.changed.map(([path, lines]) => [path, lines === null ? null : new Set(lines)])),
      diagnostics: { ...value.diagnostics, restored: true, budget: budget.snapshot() } };
  }
  let bounds = { ...DEFAULT_BOUNDS };
  const boundedPrompt = (merging: boolean) => prContextPrompt(merging) + `\nОграничения этого запуска: summary <= ${bounds.summary}, changes <= ${bounds.changes} символов; ` +
    `unresolved — не более20 пунктов по${bounds.question} символов, при необходимости сгруппируй вопросы без потери существенных ограничений.`;
  const text = async (units: SourceUnit[]) => (await Promise.all(units.map(async unit => "=== MATERIAL " + JSON.stringify({ sourceId: unit.source.id,
    metadata: unit.source.kind === "diff" ? diffRangeMetadata(unit) : { path: unit.source.path } }) + " ===\n" + await unitText(unit) + "\n=== END MATERIAL ==="))).join("\n");
  const template = (merging: boolean, selectedLimits = limits) => ({ version: "pr-context-v3.4", limits: selectedLimits,
    split: merging ? async () => { throw new Error("context_limit: one PR description cannot fit"); } : splitDiffUnit,
    template: async (units: SourceUnit[]): Promise<ChatMessage[]> => [{ role: "system", content: boundedPrompt(merging) },
      { role: "user", content: options.context + "\nВерсии base/merge-base/head: " + revision + "\nНазначенные материалы:\n" + await text(units) }] });
  const worstAnswer = (): PartAnswer => ({ summary: "\\".repeat(bounds.summary), changes: "\\".repeat(bounds.changes),
    unresolved: Array.from({ length: 20 }, () => "\\".repeat(bounds.question)), refreshOverview: null, candidates: [] });
  const worstPaths = [...repository.sources].sort((a, b) => JSON.stringify(b.path).length - JSON.stringify(a.path).length).slice(0, 40).map(s => sourceUnit(s));
  // A currently single request may become multipart after a smaller fallback/API window.
  while (repository.sources.length > 0) {
    const probe = ["a", "b"].map(id => description({ id: id.repeat(64), answer: worstAnswer(), units: worstPaths, files: [], denied: [] }, revision));
    if (measureContext(await template(true).template(probe.map(s => sourceUnit(s))), { ...limits,
      contextTokens: Math.min(limits.contextTokens, options.fallback?.contextTokens ?? limits.contextTokens) }).fits) break;
    if (bounds.summary <= 64 && bounds.changes <= 128 && bounds.question <= 16) throw new Error("context_limit: context cannot merge bounded PR descriptions");
    bounds = { summary: Math.max(64, Math.floor(bounds.summary * 0.75)), changes: Math.max(128, Math.floor(bounds.changes * 0.75)), question: Math.max(16, Math.floor(bounds.question * 0.75)) };
  }
  let parts = await packContext(repository.sources, template(false));
  const replacements = contextReplacements(store, limits, template);
  parts = await replacements.restoreAll(parts, false);
  if (!parts.length) return { quality: "complete", result: { summary: "Изменений между закреплёнными версиями нет.", findings: [], notes: null }, changed: new Map(), files: [], diagnostics: { quality: "complete", parts: 0 } };
  const nodeKey = (id: string) => hashText(JSON.stringify([id, options.primary.provider, options.primary.model.id, options.fallback?.provider, options.fallback?.model.id]));
  const checkedKey = (node: Node) => hashText(JSON.stringify([revision, node.answer, node.units.map(u => u.id), node.files,
    node.fullEvidence ?? false, prContextVerifyPrompt(), "verification-v3.4"]));
  type Verification = Awaited<ReturnType<typeof verifyPrNode>>;
  const loadVerification = (node: Node): Verification | null => {
    const saved = store.load("pr-checked:" + node.id, checkedKey(node));
    if (!saved) return null;
    const value = JSON.parse(saved.content) as Verification;
    if (!Array.isArray(value.decisions) || !Array.isArray(value.evidenceRecords) || !Array.isArray(value.proofs) || !Array.isArray(value.issues) || !Array.isArray(value.unresolved)) throw new Error("invalid_format: corrupt verification checkpoint");
    if (value.issues.length || value.unresolved.length ||
      value.decisions.some(d => d.status === "unresolved") || value.evidenceRecords.some(r => !store.load(r.id, r.hash))) return null;
    return { ...value, cost: 0 };
  };
  const verifyNode = async (node: Node, reserve: number, planning = false) => {
    const cached = loadVerification(node);
    if (cached) return cached;
    const check = await verifyPrNode(node, { ...options, store, ask }, limits, reserve, planning);
    if (!planning && !check.issues.length && !check.unresolved.length && check.decisions.every(d => d.status !== "unresolved")) {
      store.save("pr-checked:" + node.id, checkedKey(node), { content: JSON.stringify(check), provider: "internal", model: "verification-checkpoint", usage: { input: 0, output: 0 } });
    }
    return check;
  };
  const decodeCachedNode = (content: string, units: SourceUnit[], allowed: Set<string>): Node => {
    const payload = JSON.parse(content) as Omit<Node, "units">;
    const raw = { summary: payload.answer?.summary, changes: payload.answer?.changes, unresolved: payload.answer?.unresolved,
      refresh_overview: payload.answer?.refreshOverview, findings: payload.answer?.candidates?.map(c => ({ ...c.finding, prior_id: c.finding.priorId, source_ids: c.sourceIds, root_cause: c.rootCause })) };
    const answer = decodePrPart(JSON.stringify(raw), allowed, bounds);
    if (!answer || !Array.isArray(payload.files) || !Array.isArray(payload.denied)) throw new Error("invalid_format: corrupt PR checkpoint");
    return { ...payload, answer, units };
  };
  // A process can stop after Pi's final turn checkpoint and before the canonical node save.
  // Recover that boundary before admission: a valid finished draft needs no model request.
  const invalidated = new Set<string>();
  const loadNode = (part: typeof parts[number], merging: boolean, parents: Map<string, Node>): Node | null => {
    const key = nodeKey(part.id), allowed = new Set(part.units.map(u => u.source.id));
    const units = merging ? part.units.flatMap(u => parents.get(u.source.id)!.units) : part.units;
    const cached = store.load("pr-node:" + key, part.requestHash);
    if (cached) {
      const node = decodeCachedNode(cached.content, units, allowed);
      if (node.capabilityKey !== options.capabilityKey && (node.denied.length || node.answer.unresolved.length)) { invalidated.add(key); return null; }
      return node;
    }
    if (invalidated.has(key)) return null;
    const saved = store.load("pr-agent:" + key, part.requestHash);
    if (!saved) return null;
    const checkpoint = JSON.parse(saved.content) as PrAgentCheckpoint;
    const last = checkpoint.messages.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop") return null;
    const answer = decodePrPart(last.content.filter(c => c.type === "text").map(c => c.type === "text" ? c.text : "").join("\n"), allowed, bounds);
    if (!answer) return null;
    const files = new Map<string, ReadWholeFileResult>(), denied: ReadWholeFileResult[] = [];
    for (const message of checkpoint.messages) {
      if (message.role !== "toolResult" || message.toolName !== "read_file") continue;
      const file = JSON.parse(message.content.filter(c => c.type === "text").map(c => c.type === "text" ? c.text : "").join("")) as ReadWholeFileResult;
      if (file.status === "ok" && typeof file.text === "string") files.set(JSON.stringify([file.path, file.revision]), file);
      else if (file.status === "denied") denied.push(file);
    }
    const node: Node = { id: key, answer, units, files: [...files.values()], denied, capabilityKey: options.capabilityKey,
      refs: merging ? Object.fromEntries(part.units.map(u => [u.source.id, [...new Set(parents.get(u.source.id)!.units.map(v => v.source.id))]])) : undefined };
    store.save("pr-node:" + key, part.requestHash, { content: JSON.stringify({ ...node, units: undefined }),
      provider: options.primary.provider, model: options.primary.model.id, usage: { input: 0, output: 0 } });
    return node;
  };
  emit({ type: "pr_plan", revision, parts: parts.map(p => ({ id: p.id, sources: p.units.map(u => ({ source: u.source.id, from: u.from, to: u.to })) })), estimated: true });
  const allNodes: Node[] = [];
  const findings: ReconciledFinding[] = [];
  const decisions = new Map<string, { finding: ReconciledFinding; status: "confirmed" | "refuted" | "unresolved"; owners: Node[] }>();
  const issues: Array<{ reason: string; retryable: boolean; detail: string }> = [];
  const verificationHistory: Array<{ ids: string[]; unresolved: string[]; issues: typeof issues }> = [];
  const unresolved: string[] = repository.sources.filter(s => s.omittedReason).map(s => `${s.path}: ${s.omittedReason}`);
  let level = 0;
  let previousNodes = new Map<string, Node>();
  const effective = { ...options, store, ask };
  const priorGroups = await buildPriorGroups(effective, limits);
  const estimateRemainingPlan = async (work: typeof parts, merging: boolean): Promise<number> => {
    let parents = new Map([...previousNodes].map(([id, node]) => [id, { node, known: true }]));
    let cost = (await checkPriorGroups(priorGroups, effective, limits, true)).cost, current = work, isMerge = merging;
    while (true) {
      const records: Array<{ node: Node; known: boolean }> = [];
      for (const part of current) {
        const knownInput = !isMerge || part.units.every(u => parents.get(u.source.id)?.known);
        const saved = knownInput ? loadNode(part, isMerge, new Map([...parents].map(([id, record]) => [id, record.node]))) : null;
        if (saved) {
          const node = saved;
          const check = await verifyNode(node, 0, true);
          cost += check.cost;
          records.push({ node, known: true });
        } else {
          cost += 2 * part.measurement.required + outputTokens;
          records.push({ node: { id: nodeKey(part.id), answer: worstAnswer(), units: worstPaths, files: [], denied: [] }, known: false });
        }
      }
      if (records.length === 1) break;
      const sources = records.map(r => description(r.node, revision));
      parents = new Map(sources.map((s, i) => [s.id, records[i]]));
      const next = await packContext(sources, template(true));
      for (let i = 0; i < next.length; i++) {
        if (!next[i].units.every(u => parents.get(u.source.id)?.known)) continue;
        const children = await replacements.restore(next[i], true);
        if (children) { next.splice(i, 1, ...children); i--; }
      }
      if (next.length >= current.length) throw new Error("context_limit: bounded integration cannot make progress");
      current = next; isMerge = true;
    }
    return cost;
  };
  if (await estimateRemainingPlan(parts, false) > budget.remainingTokens) throw new ExecutionBudgetError("token_limit");
  while (true) {
    const nodes: Node[] = [];
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      const merging = level > 0;
      const restored = await replacements.restore(part, merging);
      if (restored) { parts.splice(partIndex, 1, ...restored); partIndex--; continue; }
      const selectedLimits = replacements.limits(part);
      const request = await rebuildPartRequest(part, template(merging, selectedLimits));
      const key = nodeKey(part.id);
      const cached = loadNode(part, merging, previousNodes);
      let node: Node;
      if (cached) {
        node = cached;
        emit({ type: "pr_part_reused", id: key });
      } else {
        const checkpoint = invalidated.has(key) ? null : store.load("pr-agent:" + key, part.requestHash);
        const plan = await estimateRemainingPlan(parts, merging);
        const futureReserve = Math.max(0, plan - 2 * part.measurement.required - outputTokens);
        const run = await runPrContextAgent({ repository, systemPrompt: request[0].content, userPrompt: request[1].content,
          primary: { ...options.primary, contextTokens: selectedLimits.contextTokens },
          fallback: options.fallback ? { ...options.fallback, contextTokens: Math.min(options.fallback.contextTokens, selectedLimits.contextTokens) } : undefined,
          budget, outputTokens, futureReserve,
          checkpoint: checkpoint ? JSON.parse(checkpoint.content) as PrAgentCheckpoint : undefined,
          onCheckpoint: state => store.save("pr-agent:" + key, part.requestHash, { content: JSON.stringify(state), provider: "internal", model: "agent-state", usage: { input: 0, output: 0 } }),
          onEvent: emit });
        if (run.error) {
          emit({ type: "pr_part_failed", id: key, reason: run.reason, detail: run.error.slice(0, 500) });
          if (run.reason === "context_limit") {
            const children = await replacements.repack(part, merging, new ContextWindowError(run.contextTokens ?? selectedLimits.contextTokens));
            emit({ type: "pr_part_repacked", parent: part.id, children: children.map(p => p.id) });
            parts.splice(partIndex, 1, ...children); partIndex--; continue;
          }
          if (run.reason?.startsWith("provider_")) throw new LlmRequestError(run.error, run.reason, run.retryable ?? true);
          throw new ExecutionBudgetError(run.reason ?? "process_failure");
        }
        const allowed = new Set(part.units.map(u => u.source.id));
        const repaired = await repairSchema({ content: run.text, provider: options.primary.provider, model: options.primary.model.id, usage: { input: 0, output: 0 } },
          raw => decodePrPart(raw, allowed, bounds), { id: "pr-node:" + key, hash: part.requestHash, schema: boundedPrompt(merging) + "\nДопустимые source_ids: " + JSON.stringify([...allowed]),
            limits: selectedLimits, budget, reserve: futureReserve, store, ask, fallbackContextTokens: options.fallback?.contextTokens });
        const answer = repaired.value;
        if (!answer) throw new Error("invalid_format: PR response failed schema validation");
        node = { id: key, answer, units: merging ? part.units.flatMap(u => previousNodes.get(u.source.id)!.units) : part.units, files: run.files, denied: run.denied, capabilityKey: options.capabilityKey,
          refs: merging ? Object.fromEntries(part.units.map(u => [u.source.id, [...new Set(previousNodes.get(u.source.id)!.units.map(v => v.source.id))]])) : undefined };
        store.save("pr-node:" + key, part.requestHash, { content: JSON.stringify({ id: node.id, answer: node.answer, files: node.files, denied: node.denied, refs: node.refs, capabilityKey: node.capabilityKey }),
          provider: options.primary.provider, model: options.primary.model.id, usage: { input: 0, output: 0 } });
      }
      nodes.push(node); allNodes.push(node); unresolved.push(...node.answer.unresolved, ...node.denied.map(d => `${d.path}: ${d.reason}`));
      const ownVerification = await verifyNode(node, 0, true);
      const reserve = Math.max(0, await estimateRemainingPlan(parts, merging) - ownVerification.cost);
      const verification = await verifyNode(node, reserve);
      verificationHistory.push({ ids: verification.decisions.map(d => d.id), unresolved: verification.unresolved, issues: verification.issues });
      for (const decision of verification.decisions) {
        const previous = decisions.get(decision.id);
        const proof = verification.proofs.find(p => p.id === decision.id);
        const proofOwner = proof ? { ...node, files: proof.files, units: proof.ranges.map(range => {
          const original = node.units.find(u => u.source.id === range.source);
          if (!original) throw new Error("Invalid verification evidence checkpoint");
          return sourceUnit(original.source, range.from, range.to);
        }) } : node;
        if (previous && previous.status !== decision.status && previous.status !== "unresolved" && decision.status !== "unresolved") {
          const owners = [...previous.owners, proofOwner];
          const conflict: Node = { ...node, id: "conflict:" + decision.id, fullEvidence: true,
            units: [...new Map(owners.flatMap(n => n.units).map(u => [u.id, u])).values()], files: owners.flatMap(n => n.files),
            answer: { ...node.answer, candidates: [node.answer.candidates.find(c => c.finding === decision.finding)!] } };
          const check = await verifyNode(conflict, reserve);
          const final = check.decisions[0];
          decisions.set(decision.id, { finding: final?.finding ?? decision.finding, status: final?.status ?? "unresolved", owners });
          verificationHistory.push({ ids: [decision.id], unresolved: check.unresolved, issues: check.issues });
        } else decisions.set(decision.id, { finding: decision.finding, status: decision.status, owners: [...(previous?.owners ?? []), proofOwner] });
      }
    }
    if (nodes.length === 1) break;
    const sources = nodes.map(node => description(node, revision));
    previousNodes = new Map(sources.map((s, i) => [s.id, nodes[i]]));
    const next = await replacements.restoreAll(await packContext(sources, template(true)), true);
    if (next.length >= parts.length) throw new Error("context_limit: PR integration made no progress");
    parts = next; level++;
  }
  // One global prior stage; batching never independently applies status changes.
  for (const history of verificationHistory) {
    if (!history.ids.some(id => decisions.get(id)?.status === "unresolved")) continue;
    unresolved.push(...history.unresolved); issues.push(...history.issues);
  }
  findings.push(...[...decisions.values()].filter(d => d.status === "confirmed").map(d => d.finding));
  const priorCheck = await checkPriorGroups(priorGroups, effective, limits);
  findings.push(...priorCheck.findings); issues.push(...priorCheck.issues);
  unresolved.push(...priorCheck.issues.map(i => i.detail + ": " + i.reason));
  const quality = unresolved.length ? "limited" : "complete";
  const changed: ChangedLines = new Map(repository.sources.map(s => [s.path, s.path.toLowerCase().endsWith(".ipynb") || s.omittedReason || !s.hunks.length ? null : new Set(s.lines.flatMap(l => l.operation === "+" && l.newLine !== null ? [l.newLine] : []))]));
  const summaries = allNodes.filter(n => n.units.length && n.answer.summary).slice(-10).map(n => n.answer.summary);
  const completed: PrPipelineResult = { quality, result: { summary: summaries.join("\n"), findings: quality === "limited" ? findings.filter(f => f.priorId === null) : findings,
    notes: null, refreshOverview: allNodes.map(n => n.answer.refreshOverview).find(Boolean) ?? null },
    changed, files: repository.changes.map(c => c.newPath), diagnostics: { quality, parts: allNodes.length, integrationLevels: level,
      unresolved: [...new Set(unresolved)], verified: [...decisions].filter(([, d]) => d.status === "confirmed").map(([id]) => id),
      rejected: [...decisions].filter(([, d]) => d.status === "refuted").map(([id]) => id), issues, revisions: { base: repository.base, mergeBase: repository.mergeBase, head: repository.head },
      exclusions: repository.sources.filter(s => s.omittedReason).map(s => ({ path: s.path, reason: s.omittedReason })), budget: budget.snapshot() } };
  if (quality === "complete") store.save("pr-final", finalKey, { content: JSON.stringify({ ...completed,
    changed: [...changed].map(([path, lines]) => [path, lines === null ? null : [...lines]]) }),
    provider: "internal", model: "pr-final", usage: { input: 0, output: 0 } });
  return completed;
}
