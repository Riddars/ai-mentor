import assert from "node:assert/strict";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { diffSources, type DiffChange, type ReviewRepository } from "@/lib/curator/pr-full-diff";
import { runPrPipeline } from "@/lib/curator/pr-pipeline";
import { memoryPipelineStore } from "@/lib/curator/pipeline-store";
import { ExecutionBudget } from "@/lib/llm/execution";
import { repairSchema } from "@/lib/curator/schema-repair";

const changes: DiffChange[] = Array.from({ length: 4 }, (_, i) => ({ oldMode: "100644", newMode: "100644", oldBlob: "c".repeat(40), newBlob: "d".repeat(40), oldPath: `${i}.ts`, newPath: `${i}.ts`, status: "M" }));
const sources = diffSources(Buffer.from(changes.map(c => `diff --git a/${c.newPath} b/${c.newPath}\n--- a/${c.newPath}\n+++ b/${c.newPath}\n@@ -0,0 +1 @@\n+${"x".repeat(8000)}\n`).join("")), changes, "recovery");
const repository: ReviewRepository = { base: "a".repeat(40), head: "b".repeat(40), mergeBase: "a".repeat(40), changes, sources, readFile: async () => null };
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const answer = JSON.stringify({ summary: "reviewed", changes: "source contracts", unresolved: [], refresh_overview: null, findings: [] });
const seen: string[] = [];
faux.setResponses(Array.from({ length: 30 }, () => context => {
  seen.push(JSON.stringify(context.messages));
  return fauxAssistantMessage(fauxText(answer));
}));
let unavailable = true;
const primary = { provider: "primary", model: faux.getModel(), contextTokens: 40000,
  stream: ((...args: Parameters<typeof models.streamSimple>) => {
    if (unavailable) { unavailable = false; throw new Error("network outage"); }
    return models.streamSimple(...args);
  }) as typeof models.streamSimple };
const fallback = { ...primary, provider: "fallback", contextTokens: 16000, stream: models.streamSimple.bind(models) };
const memory = memoryPipelineStore();
let interrupt = true;
const saved = { load: memory.load, save: (id: string, hash: string, value: Parameters<typeof memory.save>[2]) => {
  memory.save(id, hash, value);
  if (id.startsWith("pr-node:") && interrupt) { interrupt = false; throw new Error("interruption after first repacked child"); }
} };
const budget = new ExecutionBudget({ maxTokens: 950000, deadlineAt: Date.now() + 60000 });
const options = { repository, primary, fallback, budget, store: saved, outputTokens: 1000, context: "fixture" };
await assert.rejects(runPrPipeline(options), /interruption after first repacked child/);
const first = seen[0], before = seen.length;
const restored = await runPrPipeline(options);
assert.equal(restored.quality, "complete");
assert.ok(seen.length > before, "unfinished children and final integration still execute");
assert.equal(seen.filter(s => s === first).length, 1, "completed replacement child not replayed after restart");
const completed = seen.length;
await runPrPipeline({ ...options, budget: new ExecutionBudget({ maxTokens: 100, deadlineAt: Date.now() + 60000 }) });
assert.equal(seen.length, completed);

let repairs = 0;
const schemaStore = memoryPipelineStore();
const invalid = { content: "invalid", provider: "fixture", model: "fixture", usage: { input: 0, output: 0 } };
const repairOptions = { id: "fixture", hash: "same", schema: '{"ok":true}', limits: { contextTokens: 16000, outputTokens: 1000 },
  budget, reserve: 0, store: schemaStore, ask: async (messages: Array<{ content: string }>) => {
    repairs++; assert.ok(!messages.some(m => m.content.includes("diff --git")), "repairs never replay repository");
    return invalid;
  } };
await repairSchema(invalid, () => null, repairOptions);
await repairSchema(invalid, () => null, repairOptions);
assert.equal(repairs, 2, "two format repairs total, not two per process restart");
console.log("ok PR recovery: smaller fallback replan, durable failed-parent replacement, completed siblings reused, bounded schema repair across restarts");
