import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMapPipeline, decodeMapAnswer } from "@/lib/curator/map-pipeline";
import { memoryPipelineStore } from "@/lib/curator/pipeline-store";
import { ContextWindowError, ExecutionBudget, ExecutionBudgetError } from "@/lib/llm/execution";
import type { ChatMessage, ChatOptions, ChatResult } from "@/lib/llm/chat";

const answer = JSON.stringify({ summary: "Карта", findings: [], notes: "### Суть\nПроект.\n### Карта репозитория\nmain.ts — код.\n### Путь данных\nнет\n### Сознательные решения\nнет" });
assert.ok(decodeMapAnswer(answer));
assert.equal(decodeMapAnswer(JSON.stringify({ summary: "bad", findings: [], notes: "no headings" })), null);
assert.equal(decodeMapAnswer(answer.replace('"findings":[]', '"findings":[{}]')), null);
const budget = () => new ExecutionBudget({ maxTokens: 950000, deadlineAt: Date.now() + 60000 });
const directory = await mkdtemp(join(tmpdir(), "map-pipeline-test-"));
const messagesSeen: ChatMessage[][] = [];
const ask = async (messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult> => {
  messagesSeen.push(messages);
  assert.equal(messages.length, 2);
  options?.budget?.charge({ input: 123, output: 45 });
  return { content: answer, provider: "fixture", model: "fixture", usage: { input: 123, output: 45 } };
};
try {
  await writeFile(join(directory, "main.ts"), "console.log(123)");
  const store = memoryPipelineStore();
  let result = await runMapPipeline(directory, "map", budget(), () => {}, { revision: "sha", store, ask });
  assert.equal(messagesSeen.length, 1, "small repository takes one call");
  assert.equal(result.reply.partialReview, false);
  assert.equal(result.reply.toolCalls, 0);
  await runMapPipeline(directory, "map", budget(), () => {}, { revision: "sha", store, ask });
  assert.equal(messagesSeen.length, 1, "completed checkpoint reused without model");
  await runMapPipeline(directory, "map", new ExecutionBudget({ maxTokens: 100, deadlineAt: Date.now() + 60000 }), () => {}, { revision: "sha", store, ask });
  assert.equal(messagesSeen.length, 1, "finished result can be recovered with only 100 tokens left");
  for (let i = 0; i < 6; i++) await writeFile(join(directory, `file-${i}.cs`), "x".repeat(7000));
  const limits = { contextTokens: 16000, outputTokens: 2000, safetyRatio: 0.15 };
  const durable = memoryPipelineStore();
  let attempt = 0;
  const interruptedBudget = budget();
  await assert.rejects(runMapPipeline(directory, "map", interruptedBudget, () => {}, { revision: "sha2", limits, store: durable,
    ask: async (messages, opts) => { if (++attempt === 2) throw new Error("simulated worker interruption"); return ask(messages, opts); } }), /interruption/);
  const seenBeforeResume = messagesSeen.length;
  const events: Record<string, unknown>[] = [];
  result = await runMapPipeline(directory, "map", interruptedBudget, e => { events.push(e); }, { revision: "sha2", limits, store: durable, ask });
  assert.ok(events.some(e => e.type === "map_part_reused"));
  assert.ok(messagesSeen.length > seenBeforeResume);
  assert.ok((result.reply.diagnostics?.snapshot?.levels as number) > 0, "parts are reduced to one map");
  const countAfterComplete = messagesSeen.length;
  await runMapPipeline(directory, "map", interruptedBudget, () => {}, { revision: "sha2", limits, store: durable, ask });
  assert.equal(messagesSeen.length, countAfterComplete, "all completed leaf and reducer responses reused");
  let called = false;
  await assert.rejects(runMapPipeline(directory, "map", new ExecutionBudget({ maxTokens: 100, deadlineAt: Date.now() + 60000 }), () => {},
    { revision: "budget", limits, ask: async () => { called = true; throw new Error("not allowed"); } }), ExecutionBudgetError);
  assert.equal(called, false, "insufficient total budget blocks before dispatch");
  let repairs = 0;
  await runMapPipeline(directory, "repair", budget(), () => {}, { revision: "repair", ask: async (messages, opts) => {
    if (++repairs === 1) return { ...await ask(messages, opts), content: "bad-json" };
    assert.equal(opts?.phase, "json_repair");
    assert.ok(!messages[1].content.includes("x".repeat(100)), "repair does not replay source files");
    return ask(messages, opts);
  } });
  assert.equal(repairs, 2);
  // Previously valid 6000-character MiniMaps could make two-way reduction impossible.
  let bounded = 0;
  await runMapPipeline(directory, "long maps", budget(), () => {}, { revision: "long", limits,
    ask: async (messages, opts) => {
      const max = Number(/(?:Обязательный предел notes для этого запуска: |сократи notes до )(\d+)/.exec(messages[0].content)?.[1]);
      assert.ok(max > 0 && max < 6000, "output contract is fitted to reducer context before research");
      const map = JSON.parse(answer) as { notes: string };
      map.notes += "я".repeat(Math.max(0, max - map.notes.length));
      bounded++;
      return { ...await ask(messages, opts), content: JSON.stringify(map) };
    } });
  assert.ok(bounded > 1);
} finally { await rm(directory, { recursive: true, force: true }); }

const repackRoot = await mkdtemp(join(tmpdir(), "map-repack-test-"));
try {
  await writeFile(join(repackRoot, "large.ts"), "a".repeat(50000));
  const store = memoryPipelineStore();
  let attempts = 0;
  const events: Record<string, unknown>[] = [];
  await runMapPipeline(repackRoot, "map", budget(), e => { events.push(e); }, { revision: "repack", store,
    ask: async (messages, options) => {
      if (++attempts === 1) throw new ExecutionBudgetError("context_limit");
      return ask(messages, options);
    } });
  assert.ok(events.some(e => e.type === "map_part_repacked"));
  assert.ok(attempts >= 3);
  await runMapPipeline(repackRoot, "map", budget(), () => {}, { revision: "repack", store, ask: async () => { throw new Error("finished replan must resume without calls"); } });
  await runMapPipeline(repackRoot, "map", new ExecutionBudget({ maxTokens: 100, deadlineAt: Date.now() + 60000 }), () => {},
    { revision: "repack", store, ask: async () => { throw new Error("no billable recovery"); } });
  let fallback = 0;
  const fallbackEvents: Record<string, unknown>[] = [];
  await runMapPipeline(repackRoot, "fallback", budget(), e => { fallbackEvents.push(e); }, { revision: "fallback",
    ask: async (messages, opts) => { if (++fallback === 1) throw new ContextWindowError(24000); return ask(messages, opts); } });
  assert.ok(fallbackEvents.some(e => e.type === "map_part_repacked"));
} finally { await rm(repackRoot, { recursive: true, force: true }); }
const partialRoot = await mkdtemp(join(tmpdir(), "map-partial-repack-"));
try {
  await writeFile(join(partialRoot, "a.ts"), "x".repeat(100000));
  const store = memoryPipelineStore();
  let attempts = 0;
  await assert.rejects(runMapPipeline(partialRoot, "map", budget(), () => {}, { revision: "partial", store,
    ask: async (messages, opts) => {
      attempts++;
      if (attempts === 1) throw new ContextWindowError(24000);
      if (attempts === 5) throw new Error("interrupted fourth child");
      return ask(messages, opts);
    } }), /fourth child/);
  const remaining = new ExecutionBudget({ maxTokens: 950000, spent: { input: 885000, output: 0 }, deadlineAt: Date.now() + 60000 });
  let resumed = 0;
  await runMapPipeline(partialRoot, "map", remaining, () => {}, { revision: "partial", store,
    ask: async (messages, opts) => { resumed++; return ask(messages, opts); } });
  assert.equal(resumed, 2, "only fourth child and final merge run with 65000 remaining; original parent is not charged");
} finally { await rm(partialRoot, { recursive: true, force: true }); }
const largePlan = await mkdtemp(join(tmpdir(), "map-budget-tree-"));
try {
  for (let i = 0; i < 10; i++) await writeFile(join(largePlan, `${i}.ts`), "x".repeat(140000));
  let calls = 0;
  await assert.rejects(runMapPipeline(largePlan, "map", budget(), () => {}, { revision: "cost-tree",
    ask: async () => { calls++; throw new Error("must reject before reading all leaves without reducer budget"); } }), ExecutionBudgetError);
  assert.equal(calls, 0, "worst-case reducer tree reserved before first paid leaf");
} finally { await rm(largePlan, { recursive: true, force: true }); }
const reducerResume = await mkdtemp(join(tmpdir(), "map-reducer-resume-"));
try {
  for (let i = 0; i < 6; i++) await writeFile(join(reducerResume, `${i}.ts`), "x".repeat(140000));
  const store = memoryPipelineStore();
  const longMap = JSON.parse(answer) as { notes: string };
  longMap.notes += "я".repeat(6000 - longMap.notes.length);
  let reducers = 0;
  const bigBudget = () => new ExecutionBudget({ maxTokens: 2000000, deadlineAt: Date.now() + 60000 });
  await assert.rejects(runMapPipeline(reducerResume, "map", bigBudget(), () => {}, { revision: "reducer", store,
    ask: async (messages, opts) => {
      if (messages[0].content.includes("Переданы ОПИСАНИЯ")) {
        reducers++;
        if (reducers === 1) throw new ContextWindowError(24000);
        if (reducers === 4) throw new Error("third reducer child interrupted");
        return ask(messages, opts);
      }
      return { ...await ask(messages, opts), content: JSON.stringify(longMap) };
    } }), /third reducer child/);
  let resumed = 0;
  const remaining = new ExecutionBudget({ maxTokens: 950000, spent: { input: 900000, output: 0 }, deadlineAt: Date.now() + 60000 });
  await runMapPipeline(reducerResume, "map", remaining, () => {}, { revision: "reducer", store,
    ask: async (messages, opts) => { resumed++; return ask(messages, opts); } });
  assert.equal(resumed, 2, "only missing reducer child and final merge run with 50000 remaining");
} finally { await rm(reducerResume, { recursive: true, force: true }); }
console.log("ok map pipeline: single call, multipart reduction, interruption/resume, no rebilling completed parts, budget preflight, bounded format repair, context replan persisted across restart");
