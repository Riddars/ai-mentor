import type { ChatMessage } from "@/lib/llm/chat";
import { ContextWindowError } from "@/lib/llm/execution";
import { assertUnitCoverage, packUnits, sourceUnit, type ContextPart, type PackOptions } from "./context-parts";
import type { ContextLimits } from "./context-size";
import type { PipelineStore } from "./pipeline-store";

/** Durable replacement trees preserve completed siblings when an API rejects our estimate. */
export function contextReplacements(store: PipelineStore, initial: ContextLimits,
  template: (merging: boolean, limits: ContextLimits) => PackOptions<ChatMessage[]>) {
  const states = new Map<string, { limits: ContextLimits; depth: number }>();
  const state = (part: ContextPart<ChatMessage[]>) => states.get(part.id) ?? { limits: initial, depth: 0 };
  const restore = async (part: ContextPart<ChatMessage[]>, merging: boolean) => {
    const saved = store.load("pr-replacement:" + part.id, part.requestHash);
    if (!saved) return null;
    const plan = JSON.parse(saved.content) as { limits: ContextLimits; depth: number; groups: Array<Array<{ source: string; from: number; to: number }>> };
    if (plan.depth !== state(part).depth + 1 || plan.depth > 3 || !Array.isArray(plan.groups) || !plan.groups.length ||
      !Number.isFinite(plan.limits.contextTokens) || plan.limits.contextTokens >= state(part).limits.contextTokens) throw new Error("Corrupt PR replacement tree");
    const sources = new Map(part.units.map(u => [u.source.id, u.source]));
    const groups = plan.groups.map(group => group.map(range => {
      const source = sources.get(range.source);
      if (!source) throw new Error("Replacement source changed");
      return sourceUnit(source, range.from, range.to);
    }));
    assertUnitCoverage(part.units, groups.flat());
    const children: ContextPart<ChatMessage[]>[] = [];
    for (const group of groups) children.push(...await packUnits(group, template(merging, plan.limits)));
    if (children.some(p => p.id === part.id)) throw new Error("Replacement made no progress");
    for (const child of children) states.set(child.id, { limits: plan.limits, depth: plan.depth });
    return children;
  };
  return { limits: (part: ContextPart<ChatMessage[]>) => state(part).limits, restore,
    async restoreAll(parts: ContextPart<ChatMessage[]>[], merging: boolean) {
      for (let i = 0; i < parts.length; i++) {
        const children = await restore(parts[i], merging);
        if (children) { parts.splice(i, 1, ...children); i--; }
      }
      return parts;
    },
    async repack(part: ContextPart<ChatMessage[]>, merging: boolean, error: ContextWindowError) {
      const previous = state(part);
      if (previous.depth >= 3) throw error;
      const limits = { ...previous.limits, contextTokens: error.contextTokens < previous.limits.contextTokens
        ? error.contextTokens : Math.floor(previous.limits.contextTokens * 0.6) };
      let children = await packUnits(part.units, template(merging, limits));
      if (children.length === 1 && children[0].requestHash === part.requestHash) {
        const groups = part.units.length > 1
          ? [part.units.slice(0, Math.ceil(part.units.length / 2)), part.units.slice(Math.ceil(part.units.length / 2))]
          : merging ? [] : (await template(false, limits).split!(part.units[0])).map(unit => [unit]);
        if (!groups.length) throw error;
        children = [];
        for (const group of groups) children.push(...await packUnits(group, template(merging, limits)));
      }
      assertUnitCoverage(part.units, children.flatMap(p => p.units));
      store.save("pr-replacement:" + part.id, part.requestHash, { content: JSON.stringify({ limits, depth: previous.depth + 1,
        groups: children.map(p => p.units.map(u => ({ source: u.source.id, from: u.from, to: u.to }))) }),
        provider: "internal", model: "replacement-tree", usage: { input: 0, output: 0 } });
      for (const child of children) states.set(child.id, { limits, depth: previous.depth + 1 });
      return children;
    } };
}
