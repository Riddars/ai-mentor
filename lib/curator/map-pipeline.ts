import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chat, type ChatMessage, type ChatOptions, type ChatResult } from "@/lib/llm/chat";
import { ExecutionBudget, ExecutionBudgetError } from "@/lib/llm/execution";
import type { AgentRun } from "@/lib/agent/run";
import { initialMapPrompt } from "./prompts";
import { assertUnitCoverage, hashText, packContext, packUnits, sourceUnit, splitTextUnit, rebuildPartRequest, unitText, type ContextPart, type ContextSource, type PackOptions } from "./context-parts";
import { measureContext, type ContextLimits } from "./context-size";
import { repositoryInventory } from "./repository-inventory";
import { memoryPipelineStore, sqlitePipelineStore, type PipelineStore } from "./pipeline-store";

interface MapAnswer { summary: string; notes: string; findings: never[] }
const HEADINGS = ["### Суть", "### Карта репозитория", "### Путь данных", "### Сознательные решения"];
export function decodeMapAnswer(raw: string, maxNotes = 6000): MapAnswer | null {
  try {
    const text = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    const value = JSON.parse(text) as MapAnswer;
    if (!value || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 1500 ||
      typeof value.notes !== "string" || !value.notes.trim() || value.notes.length > maxNotes ||
      !Array.isArray(value.findings) || value.findings.length || !HEADINGS.every(h => value.notes.includes(h))) return null;
    return { summary: value.summary, notes: value.notes, findings: [] };
  } catch { return null; }
}
export interface MapPipelineOptions {
  revision: string;
  scope?: string;
  store?: PipelineStore;
  limits?: ContextLimits;
  ask?: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult>;
}
const mergeRules = "\nПереданы ОПИСАНИЯ частей, а не исходники. Объедини их в карту. " +
  "Сохрани источники и существенные неопределённости; противоречия не разрешай догадками. Не утверждай, что видел отсутствующий код.";
const partRules = "\nЕсли передан только фрагмент проекта, опиши именно его. " +
  "Отметь внешние зависимости и непроверенные связи. Включай пути источников. notes не более 6000 символов.";
function descriptionSource(id: string, map: MapAnswer, revision: string): ContextSource {
  const bytes = Buffer.from(JSON.stringify({ sourcePart: id, map }), "utf8");
  const viewHash = hashText(bytes);
  return { id: hashText(id + viewHash), path: `map-part:${id}`, revision, kind: "description", bytes: bytes.length,
    originalHash: viewHash, viewHash, transformation: "map-description-v1", read: async (from, to) => bytes.subarray(from, to) };
}

export async function runMapPipeline(root: string, task: string, budget: ExecutionBudget,
  onEvent: (event: Record<string, unknown>) => void, options: MapPipelineOptions): Promise<AgentRun> {
  const scratch = await mkdtemp(join(tmpdir(), "curator-map-views-"));
  const before = { ...budget.spent };
  try {
    const inventory = await repositoryInventory(root, options.revision, scratch);
    if (!inventory.sources.length) throw new Error("incomplete_snapshot: no eligible materials for project map");
    const limits = options.limits ?? { contextTokens: Number(process.env.INITIAL_MAP_CONTEXT_TOKENS ?? 128000), outputTokens: 4000, safetyRatio: 0.15 };
    let notesLimit = 6000;
    let rules = initialMapPrompt() + partRules;
    const ask = options.ask ?? chat;
    const excluded = inventory.excluded.slice(0, 100);
    const exclusions = JSON.stringify({ excluded, total: inventory.excluded.length, omitted: inventory.excluded.length - excluded.length });
    const template = (merging: boolean, selectedLimits = limits): PackOptions<ChatMessage[]> => ({ limits: selectedLimits, version: "map-v3.1",
      split: merging ? async () => { throw new Error("context_limit: one map description cannot fit reducer"); } : undefined,
      template: async units => [{ role: "system", content: rules + (merging ? mergeRules : "") }, { role: "user", content:
        task + "\nКоммит: " + options.revision + "\nИсключения: " + exclusions + "\n\n" +
        (await Promise.all(units.map(async unit => `=== ${merging ? "DESCRIPTION" : "FILE"} ${JSON.stringify(unit.source.path)} ${unit.from}:${unit.to} bytes ===\n${await unitText(unit)}\n=== END ===`))).join("\n\n") }] });
    // A valid maximum-sized response must permit at least a two-way reduction.
    // Backslashes exercise double JSON escaping, more expensive than ordinary prose.
    const mergeLimits = { ...limits, contextTokens: Math.min(limits.contextTokens, Number(process.env.LLM_FALLBACK_CONTEXT_TOKENS ?? limits.contextTokens)) };
    while (true) {
      rules = initialMapPrompt() + partRules + `\nОбязательный предел notes для этого запуска: ${notesLimit} символов.`;
      const worst: MapAnswer = { summary: "\\".repeat(1500), findings: [], notes: "\\".repeat(notesLimit) };
      const probe = [descriptionSource("a".repeat(64), worst, options.revision), descriptionSource("b".repeat(64), worst, options.revision)];
      if (measureContext(await template(true).template(probe.map(s => sourceUnit(s))), mergeLimits).fits) break;
      if (notesLimit <= 128) throw new Error("configuration_error: context cannot merge two bounded map descriptions");
      notesLimit = Math.max(128, Math.floor(notesLimit * 0.75));
    }
    const scope = hashText(JSON.stringify([options.scope, options.revision, task, rules, mergeRules,
      process.env.LLM_PROVIDER, process.env.LLM_MODEL, process.env.LLM_FALLBACK_PROVIDER, process.env.LLM_FALLBACK_MODEL, "map-v3.2"]));
    const store = options.store ?? (options.scope ? sqlitePipelineStore(scope) : memoryPipelineStore());
    const finalHash = hashText(JSON.stringify([inventory.sources.map(s => s.id), inventory.excluded, rules, task]));
    const savedFinal = store.load("final", finalHash);
    const repacked = new Map<string, { limits: ContextLimits; depth: number }>();
    const restoreReplacement = async (part: ContextPart<ChatMessage[]>, merging: boolean) => {
      const saved = store.load("replacement:" + part.id, part.requestHash);
      if (!saved) return null;
      const plan = JSON.parse(saved.content) as { limits: ContextLimits; depth: number; groups: Array<Array<{ source: string; from: number; to: number }>> };
      if (plan.depth !== (repacked.get(part.id)?.depth ?? 0) + 1 || plan.depth > 3 || !Array.isArray(plan.groups) || !plan.groups.length) throw new Error("Corrupt replacement plan");
      const sources = new Map(part.units.map(u => [u.source.id, u.source]));
      const groups = plan.groups.map(group => group.map(range => {
        const source = sources.get(range.source);
        if (!source) throw new Error("Replacement references different source");
        return sourceUnit(source, range.from, range.to);
      }));
      assertUnitCoverage(part.units, groups.flat());
      const replacements = [];
      for (const group of groups) replacements.push(...await packUnits(group, template(merging, plan.limits)));
      if (replacements.some(p => p.id === part.id)) throw new Error("Replacement plan made no progress");
      for (const replacement of replacements) repacked.set(replacement.id, { limits: plan.limits, depth: plan.depth });
      return replacements;
    };
    let parts = await packContext(inventory.sources, template(false));
    // Restore failed parents BEFORE budgeting: their completed children must not be billed again.
    for (let index = 0; index < parts.length; index++) {
      const replacements = await restoreReplacement(parts[index], false);
      if (replacements) { parts.splice(index, 1, ...replacements); index--; }
    }
    onEvent({ type: "map_plan", parts: parts.map(p => ({ id: p.id, units: p.units.map(u => ({ id: u.id, path: u.source.path, from: u.from, to: u.to })), inputTokens: p.measurement.inputTokens })),
      revision: options.revision, excluded: inventory.excluded, counter: parts[0].measurement.counter, estimated: true });
    const worstMap: MapAnswer = { summary: "\\".repeat(1500), findings: [], notes: "\\".repeat(notesLimit) };
    /** Plan every remaining normal call, including all reducer levels. Cached answers use actual sizes. */
    const estimateRemaining = async (work: ContextPart<ChatMessage[]>[]): Promise<number> => {
      let cost = work.reduce((sum, p) => sum + (store.load(p.id, p.requestHash) ? 0 : p.measurement.required), 0);
      let descriptions = work.map(part => {
        const cached = store.load(part.id, part.requestHash);
        return { source: descriptionSource(part.id, cached ? decodeMapAnswer(cached.content, notesLimit)! : worstMap, options.revision), known: !!cached };
      });
      while (descriptions.length > 1) {
        const known = new Set(descriptions.filter(d => d.known).map(d => d.source.id));
        const next = await packContext(descriptions.map(d => d.source), template(true));
        if (next.length >= descriptions.length) throw new Error("context_limit: bounded reduction cannot make progress");
        for (let index = 0; index < next.length; index++) {
          if (!next[index].units.every(unit => known.has(unit.source.id))) continue;
          const restored = await restoreReplacement(next[index], true);
          if (restored) { next.splice(index, 1, ...restored); index--; }
        }
        descriptions = next.map(part => {
          const cached = part.units.every(unit => known.has(unit.source.id)) ? store.load(part.id, part.requestHash) : null;
          if (!cached) cost += part.measurement.required;
          return { source: descriptionSource(part.id, cached ? decodeMapAnswer(cached.content, notesLimit)! : worstMap, options.revision), known: !!cached };
        });
      }
      return cost;
    };
    const normalCost = savedFinal ? 0 : await estimateRemaining(parts);
    // A small repair allowance is optional; each actual repair must preserve all normal future calls.
    const repairAllowance = normalCost ? Math.min(8000, Math.max(0, budget.remainingTokens - normalCost)) : 0;
    const estimated = normalCost + repairAllowance;
    onEvent({ type: "map_budget_plan", normalCost, repairAllowance, remaining: budget.remainingTokens });
    if (estimated > budget.remainingTokens) throw new ExecutionBudgetError("token_limit");
    let last: ChatResult | undefined;
    let completed = 0;
    const execute = async (part: ContextPart<ChatMessage[]>, merging: boolean): Promise<ChatResult> => {
      const cached = store.load(part.id, part.requestHash);
      if (cached) {
        if (!decodeMapAnswer(cached.content, notesLimit)) throw new Error("invalid_format: corrupt map checkpoint");
        onEvent({ type: "map_part_reused", id: part.id }); return cached;
      }
      const selectedLimits = repacked.get(part.id)?.limits ?? limits;
      const messages = await rebuildPartRequest(part, template(merging, selectedLimits));
      const measurement = measureContext(messages, selectedLimits);
      const futureCost = await estimateRemaining(parts);
      const futureReserve = Math.max(0, futureCost - part.measurement.required);
      const reserve = futureReserve + Math.min(8000, Math.max(0, budget.remainingTokens - futureCost));
      if (measurement.required + reserve > budget.remainingTokens) throw new ExecutionBudgetError("token_limit");
      onEvent({ type: "map_part_started", id: part.id, merging });
      let answer = await ask(messages, { budget, phase: "synthesis", maxOutputTokens: limits.outputTokens, reserveTokens: reserve, onEvent,
        contextTokens: selectedLimits.contextTokens, fallbackContextTokens: Number(process.env.LLM_FALLBACK_CONTEXT_TOKENS ?? selectedLimits.contextTokens) });
      for (let attempt = 0; !decodeMapAnswer(answer.content, notesLimit) && attempt < 2; attempt++) {
        const repair: ChatMessage[] = [{ role: "system", content: `Исправь только JSON/формат. Не добавляй фактов. Сохрани смысл, сократи notes до ${notesLimit} символов. ` +
          'Схема: {"summary":"непустая строка до1500 символов","findings":[],"notes":"' + HEADINGS.join("; ") + '"}. Все четыре заголовка обязательны.' },
        { role: "user", content: answer.content }];
        if (!measureContext(repair, limits).fits) throw new Error("invalid_format: response too large for repair");
        answer = await ask(repair, { budget, phase: "json_repair", maxOutputTokens: limits.outputTokens, reserveTokens: futureReserve, onEvent,
          contextTokens: limits.contextTokens, fallbackContextTokens: Number(process.env.LLM_FALLBACK_CONTEXT_TOKENS ?? limits.contextTokens) });
      }
      const parsed = decodeMapAnswer(answer.content, notesLimit);
      if (!parsed) throw new Error("invalid_format: map response failed validation after two repairs");
      answer = { ...answer, content: JSON.stringify(parsed) };
      store.save(part.id, part.requestHash, answer);
      onEvent({ type: "map_part_completed", id: part.id, merging, completed: ++completed });
      return answer;
    };
    let merging = false;
    let levels = 0;
    while (true) {
      const answers: Array<{ id: string; answer: ChatResult }> = [];
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        const restored = await restoreReplacement(part, merging);
        if (restored) { parts.splice(index, 1, ...restored); index--; continue; }
        try { last = await execute(part, merging); answers.push({ id: part.id, answer: last }); }
        catch (error) {
          if (!(error instanceof Error) || !("reason" in error) || error.reason !== "context_limit") throw error;
          const previous = repacked.get(part.id) ?? { limits, depth: 0 };
          if (previous.depth >= 3) throw error;
          const failedWindow = "contextTokens" in error && typeof error.contextTokens === "number" && Number.isFinite(error.contextTokens)
            ? error.contextTokens : previous.limits.contextTokens;
          const smaller = { ...previous.limits, contextTokens: failedWindow < previous.limits.contextTokens
            ? failedWindow : Math.floor(previous.limits.contextTokens * 0.6) };
          let replacements = await packUnits(part.units, template(merging, smaller));
          if (replacements.length === 1 && replacements[0].requestHash === part.requestHash) {
            const groups = part.units.length > 1
              ? [part.units.slice(0, Math.ceil(part.units.length / 2)), part.units.slice(Math.ceil(part.units.length / 2))]
              : merging ? [] : (await splitTextUnit(part.units[0])).map(unit => [unit]);
            if (!groups.length) throw error;
            replacements = [];
            for (const group of groups) replacements.push(...await packUnits(group, template(merging, smaller)));
          }
          onEvent({ type: "map_part_repacked", parent: part.id, children: replacements.map(p => p.id), depth: previous.depth + 1 });
          store.save("replacement:" + part.id, part.requestHash, { content: JSON.stringify({ limits: smaller, depth: previous.depth + 1,
            groups: replacements.map(p => p.units.map(u => ({ source: u.source.id, from: u.from, to: u.to }))) }),
          provider: "internal", model: "replacement-plan", usage: { input: 0, output: 0 } });
          for (const replacement of replacements) repacked.set(replacement.id, { limits: smaller, depth: previous.depth + 1 });
          parts.splice(index, 1, ...replacements); index--;
        }
      }
      if (answers.length === 1) break;
      const sources = answers.map(({ id, answer }) => descriptionSource(id, decodeMapAnswer(answer.content, notesLimit)!, options.revision));
      const next = await packContext(sources, template(true));
      if (next.length >= parts.length) throw new Error("context_limit: map reduction made no progress");
      parts = next; merging = true; levels++;
    }
    store.save("final", finalHash, last!);
    return { provider: last!.provider, model: last!.model, calls: budget.calls,
      reply: { type: "result", text: last!.content, error: null, steps: completed, toolCalls: 0,
        tokensIn: budget.spent.input - before.input, tokensOut: budget.spent.output - before.output,
        viewed: inventory.sources.map(s => s.path), skipped: [], partialCopy: null, partialReview: false,
        transcript: JSON.stringify({ mode: "map-parts", completed, levels, sources: inventory.sources.map(s => ({ path: s.path, id: s.id })), excluded: inventory.excluded }),
        diagnostics: { version: 1, reason: "completed", calls: budget.calls, unknownTokens: budget.unknownTokens, budget: budget.snapshot(),
          snapshot: { mode: "parts", included: inventory.sources.map(s => ({ path: s.path, bytes: s.bytes })), excluded: inventory.excluded, levels, completed } } } };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
