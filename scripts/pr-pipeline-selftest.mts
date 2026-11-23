import assert from "node:assert/strict";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText, getCurrentSystemPrompt, type TranscriptContext } from "@earendil-works/pi-ai";
import { diffSources, type DiffChange, type ReviewRepository } from "@/lib/curator/pr-full-diff";
import { runPrPipeline } from "@/lib/curator/pr-pipeline";
import { memoryPipelineStore } from "@/lib/curator/pipeline-store";
import { ExecutionBudget, ExecutionBudgetError } from "@/lib/llm/execution";
import type { ChatMessage, ChatOptions } from "@/lib/llm/chat";

const changes: DiffChange[] = [], blocks: string[] = [];
for (const name of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "z.ts"]) {
  changes.push({ oldMode: "100644", newMode: "100644", oldBlob: "c".repeat(40), newBlob: "d".repeat(40), oldPath: name, newPath: name, status: "M" });
  blocks.push(`diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,2 +1,2 @@\n //${"x".repeat(5000)}\n-return 1;\n+return 2;\n`);
}
const repository: ReviewRepository = { base: "a".repeat(40), mergeBase: "a".repeat(40), head: "b".repeat(40), changes,
  sources: diffSources(Buffer.from(blocks.join("")), changes, "fixture"),
  readFile: async path => ({ path, revision: "b".repeat(40), blob: "d".repeat(40), mode: "100644", bytes: Buffer.from("//comment\nreturn 2;\n") }) };
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
let sourceCalls = 0, integrationCalls = 0, verifierCalls = 0;
let forceUnresolved = false;
let conflicting = false, injectedRead = false;
let fillBounds = false, noFindings = false;
const finding = (ids: string[]) => ({ prior_id: null, status: "open", area: "code", severity: "important", title: "Cross-part fixture",
  description: "Incompatible changes", locations: [{ kind: "file", target: "a.ts", detail: "2" }, { kind: "file", target: "z.ts", detail: "2" }],
  evidence: "return 2", impact: "fixture impact", recommendation: "fixture fix", verify: "fixture check", root_cause: "same concrete cause", source_ids: ids });
const respond = (context: TranscriptContext) => {
  const user = context.messages.find(m => m.role === "user");
  assert.ok(user && user.role === "user");
  const body = typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.type === "text" ? c.text : "").join("");
  const materials = [...body.matchAll(/^=== MATERIAL (.+) ===$/gm)].map(match => JSON.parse(match[1]) as { sourceId: string; metadata?: { change?: { newPath: string } } });
  const merging = getCurrentSystemPrompt(context.messages).includes("Сопоставь ВСЕ описания");
  const system = getCurrentSystemPrompt(context.messages);
  const max = /summary <= (\d+), changes <= (\d+)/.exec(system);
  if (merging) integrationCalls++; else sourceCalls++;
  if (merging && conflicting && !injectedRead) { injectedRead = true; return fauxAssistantMessage(fauxToolCall("read_file", { path: "context.ts" }), { stopReason: "toolUse" }); }
  return fauxAssistantMessage(fauxText(JSON.stringify({ summary: fillBounds ? "\\".repeat(Number(max![1])) : "fixture reviewed",
    changes: fillBounds ? "\\".repeat(Number(max![2])) : merging ? "combined contracts from all parts" : "documented changes and contracts",
    unresolved: fillBounds ? Array(20).fill("A long unresolved question. ".repeat(12)) : forceUnresolved ? ["source question remains open"] : [], refresh_overview: null,
    findings: !noFindings && (merging || (conflicting && materials.some(m => m.metadata?.change?.newPath === "a.ts")))
      ? [finding((merging ? materials : materials.filter(m => m.metadata?.change?.newPath === "a.ts")).map(m => m.sourceId))] : [] })));
};
faux.setResponses(Array.from({ length: 80 }, () => respond));
const ask = async (messages: ChatMessage[], options?: ChatOptions) => {
  verifierCalls++;
  assert.equal(options?.phase, "verify");
  const data = JSON.parse(messages[1].content.split("\nИсходные материалы:\n")[0]) as { candidates: Array<{ id: string }> };
  assert.ok(messages[1].content.includes('"newPath":"a.ts"'));
  assert.ok(messages[1].content.includes('"newPath":"z.ts"'));
  assert.ok(messages[1].content.includes("+return 2;"));
  options?.budget?.charge({ input: 100, output: 20 });
  return { content: JSON.stringify({ verdicts: data.candidates.map(c => ({ id: c.id, status: "confirmed", reason: "fixture source grounding" })) }),
    provider: "fixture", model: "fixture", usage: { input: 100, output: 20 } };
};
const budget = new ExecutionBudget({ maxTokens: 950000, deadlineAt: Date.now() + 60000 });
const store = memoryPipelineStore();
const options = { repository, context: "PR fixture, first map, no prior findings", primary: { provider: "fixture", model: faux.getModel(), stream: models.streamSimple.bind(models), contextTokens: 20000 },
  budget, store, ask, outputTokens: 1000, onEvent: (e: Record<string, unknown>) => { if (e.type === "pr_part_failed") console.log(e); } };
const result = await runPrPipeline(options);
assert.ok(sourceCalls > 1, "large diff partitioned");
assert.ok(integrationCalls >= 1, "parts with no local findings still take part in cross-part review");
assert.equal(verifierCalls, 1, "cross-part candidates independently checked against actual source");
assert.equal(result.quality, "complete");
assert.equal(result.result.findings.length, 1);
assert.equal(result.changed.get("a.ts")?.has(2), true);
const count = sourceCalls + integrationCalls;
await runPrPipeline({ ...options, ask: async () => { throw new Error("completed verifier must be reused"); } });
assert.equal(sourceCalls + integrationCalls, count, "completed packet/integration checkpoints are reused");
await runPrPipeline({ ...options, budget: new ExecutionBudget({ maxTokens: 100, deadlineAt: Date.now() + 60000 }),
  ask: async () => { throw new Error("completed review must not consume the remaining budget"); } });
assert.equal(sourceCalls + integrationCalls, count);
// A separate store deliberately simulates a clean chain for partial-verification recovery.
const recovering = memoryPipelineStore();
const partial = await runPrPipeline({ ...options, store: recovering, ask: async () => { throw new Error("simulated verifier outage"); } });
assert.equal(partial.quality, "limited");
const completedSourceCalls = sourceCalls + integrationCalls;
const recovered = await runPrPipeline({ ...options, store: recovering });
assert.equal(recovered.quality, "complete");
assert.equal(sourceCalls + integrationCalls, completedSourceCalls, "recovery runs only unfinished verification");

forceUnresolved = true;
const pending = { id: 7, prNumber: 1, area: "code" as const, severity: "important" as const, title: "Old issue", verify: "must be fixed",
  status: "pending" as const, locations: [{ kind: "file" as const, target: "a.ts", detail: "2" }] };
const limited = await runPrPipeline({ ...options, store: memoryPipelineStore(), prior: [pending], ask: async (messages, opts) => {
  if (messages[0].content.includes("Проверь прежние замечания")) {
    return { provider: "fixture", model: "fixture", usage: { input: 1, output: 1 }, content: JSON.stringify({ verdicts: [{ id: 7, status: "closed", reason: "fixed" }] }) };
  }
  return ask(messages, opts);
} });
assert.equal(limited.quality, "limited");
assert.ok(!limited.result.findings.some(f => f.priorId === 7), "limited review never rewrites pending to open or closed");
assert.equal(pending.status, "pending");
forceUnresolved = false;
conflicting = true;
let conflictChecks = 0;
const conflict = await runPrPipeline({ ...options, store: memoryPipelineStore(), repository: { ...repository,
  readFile: async path => ({ path, revision: repository.head, blob: "d".repeat(40), mode: "100644", bytes: Buffer.from(path === "context.ts" ? "CONTRADICTION" : "// code\nreturn 2;") }) },
ask: async (messages, opts) => {
  conflictChecks++;
  const data = JSON.parse(messages[1].content.split("\nИсходные материалы:\n")[0]) as { candidates: Array<{ id: string }> };
  opts?.budget?.charge({ input: 100, output: 20 });
  return { provider: "fixture", model: "fixture", usage: { input: 100, output: 20 }, content: JSON.stringify({ verdicts: data.candidates.map(c => ({ id: c.id,
    status: messages[1].content.includes("CONTRADICTION") ? "refuted" : "confirmed", reason: "fixture expanded evidence" })) }) };
} });
assert.equal(conflictChecks, 3, "opposite verdicts trigger a third independent check on combined actual evidence");
assert.equal(conflict.result.findings.length, 0, "early confirmation is not sticky after contradictory evidence");
assert.equal(conflict.quality, "complete");
injectedRead = false;
let deferredChecks = 0;
const deferredStore = memoryPipelineStore();
const resolvedLater = await runPrPipeline({ ...options, store: deferredStore, ask: async (messages, opts) => {
  deferredChecks++;
  const data = JSON.parse(messages[1].content.split("\nИсходные материалы:\n")[0]) as { candidates: Array<{ id: string }> };
  opts?.budget?.charge({ input: 100, output: 20 });
  return { provider: "fixture", model: "fixture", usage: { input: 100, output: 20 }, content: JSON.stringify({ verdicts: data.candidates.map(c => ({ id: c.id,
    status: deferredChecks === 1 ? "unresolved" : "confirmed", reason: "later source resolves initial uncertainty" })) }) };
} });
assert.equal(resolvedLater.quality, "complete", "resolved candidate uncertainty is history, not a permanent quality blocker");
assert.deepEqual(resolvedLater.diagnostics.unresolved, []);
const deferredCalls = sourceCalls + integrationCalls;
await runPrPipeline({ ...options, store: deferredStore, budget: new ExecutionBudget({ maxTokens: 100, deadlineAt: Date.now() + 60000 }),
  ask: async () => { throw new Error("already resolved earlier uncertainty must not trigger another verifier"); } });
assert.equal(sourceCalls + integrationCalls, deferredCalls);
conflicting = false;
fillBounds = true;
await runPrPipeline({ ...options, outputTokens: 8000, store: memoryPipelineStore(), budget: new ExecutionBudget({ maxTokens: 2000000, deadlineAt: Date.now() + 60000 }) });
fillBounds = false;
const singleChange = { ...changes[0], oldPath: "huge.ts", newPath: "huge.ts" };
const single = diffSources(Buffer.from(`diff --git a/huge.ts b/huge.ts\n--- a/huge.ts\n+++ b/huge.ts\n` + Array.from({ length: 12 }, (_, i) => `@@ -${i + 1},1 +${i + 1},1 @@\n-old\n+${"x".repeat(5000)}\n`).join("")), [singleChange], "single-huge");
const beforeSingleMerge = integrationCalls;
fillBounds = true; noFindings = true;
const singleResult = await runPrPipeline({ ...options, repository: { ...repository, changes: [singleChange], sources: single },
  outputTokens: 8000, store: memoryPipelineStore(), budget: new ExecutionBudget({ maxTokens: 2000000, deadlineAt: Date.now() + 60000 }) });
assert.ok(integrationCalls > beforeSingleMerge, "a single huge file also adapts descriptions for multipart reduction");
assert.equal(singleResult.quality, "limited", "long unresolved entries remain explicit");
assert.ok((singleResult.diagnostics.unresolved as string[]).includes("A long unresolved question. ".repeat(12)));
fillBounds = false; noFindings = false;
noFindings = true;
const crashStore = memoryPipelineStore();
let crashBeforeNode = true;
const boundaryStore = { load: crashStore.load, save: (id: string, hash: string, answer: Parameters<typeof crashStore.save>[2]) => {
  if (id.startsWith("pr-node:") && crashBeforeNode) { crashBeforeNode = false; throw new Error("crash after completed agent turn"); }
  crashStore.save(id, hash, answer);
} };
const boundaryOptions = { ...options, repository: { ...repository, changes: [changes[0]], sources: [repository.sources[0]] }, store: boundaryStore };
await assert.rejects(runPrPipeline(boundaryOptions), /crash after completed agent turn/);
const beforeBoundaryRestore = sourceCalls + integrationCalls;
const restoredBoundary = await runPrPipeline({ ...boundaryOptions, budget: new ExecutionBudget({ maxTokens: 100, deadlineAt: Date.now() + 60000 }) });
assert.equal(restoredBoundary.quality, "complete");
assert.equal(sourceCalls + integrationCalls, beforeBoundaryRestore, "finished agent turn survives a crash before node save with budget100 and zero calls");
noFindings = false;
const largeChanges: DiffChange[] = Array.from({ length: 10 }, (_, i) => ({ ...changes[0], oldPath: `${i}.ts`, newPath: `${i}.ts` }));
const large = diffSources(Buffer.from(largeChanges.map(c => `diff --git a/${c.newPath} b/${c.newPath}\n--- a/${c.newPath}\n+++ b/${c.newPath}\n@@ -0,0 +1 @@\n+${"x".repeat(140000)}\n`).join("")), largeChanges, "large");
const beforeBudgetReject = sourceCalls + integrationCalls;
await assert.rejects(runPrPipeline({ ...options, primary: { ...options.primary, contextTokens: 128000 }, outputTokens: 8000,
  repository: { ...repository, sources: large, changes: largeChanges }, store: memoryPipelineStore(), budget: new ExecutionBudget({ maxTokens: 950000, deadlineAt: Date.now() + 60000 }) }), ExecutionBudgetError);
assert.equal(sourceCalls + integrationCalls, beforeBudgetReject, "insufficient complete plan rejected before source calls");
console.log("ok PR pipeline wiring: multipart full diff, empty local findings preserved in integration, cross-part source verification, changed-line scope and no rebilling completed nodes");
