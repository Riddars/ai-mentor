import assert from "node:assert/strict";
import { chat, LlmRequestError } from "@/lib/llm/chat";
import { ExecutionBudget, ExecutionBudgetError, type LlmCallRecord } from "@/lib/llm/execution";
import { AgentProcessError, runAgentWithFallback } from "@/lib/agent/run";
import type { AgentReply, AgentRequest } from "@/lib/agent/protocol";
import { createResearchState } from "@/lib/agent/research";
import { parseOverviewDraft } from "@/lib/curator/overview-draft";

const messages = [{ role: "user" as const, content: "Review this fixture." }];
Object.assign(process.env, { LLM_PROVIDER: "selectel", LLM_MODEL: "primary-fixture", SELECTEL_API_KEY: "fixture",
  LLM_FALLBACK_PROVIDER: "provod", LLM_FALLBACK_MODEL: "reserve-fixture", PROVOD_API_KEY: "fixture" });
const budget = (tokens = 100_000) => new ExecutionBudget({ maxTokens: tokens, deadlineAt: Date.now() + 60_000, maxToolCalls: 10 });
const answer = (content = "{}", input = 100, output = 20) => Response.json({ id: "response-fixture",
  choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: input, completion_tokens: output,
    prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 } } });
const originalFetch = globalThis.fetch;
try {
  const runtime = budget(1000);
  runtime.charge({ input: 100, output: 20, cacheRead: 40, cacheWrite: 10 });
  assert.equal(runtime.remainingTokens, 880, "cached tokens must not be counted twice");
  assert.equal(runtime.admit({ inputTokens: 400, maxOutputTokens: 800, reserveTokens: 100 }).maxOutputTokens, 380);
  assert.equal(runtime.admit({ inputTokens: 800, maxOutputTokens: 800 }).reason, "token_limit");
  runtime.reserveUnknown(80);
  assert.equal(runtime.remainingTokens, 800);
  assert.deepEqual(new ExecutionBudget(JSON.parse(JSON.stringify(runtime.snapshot()))).snapshot(), runtime.snapshot());
  assert.equal(runtime.consumeTools(10), null);
  assert.equal(runtime.consumeTools(), "tool_limit");

  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return answer(); };
  const exact = budget();
  const response = await chat(messages, { budget: exact, phase: "verify" });
  assert.equal(fetched, 1);
  assert.deepEqual(exact.spent, { input: 100, output: 20 });
  assert.equal(response.calls?.[0].cacheWriteTokens, 10);
  assert.equal(response.calls?.[0].phase, "verify");
  assert.equal(exact.calls.length, 1, "start and finish update one call record");
  assert.equal(exact.calls[0].status, "succeeded");

  fetched = 0;
  globalThis.fetch = async () => ++fetched === 1 ? answer("", 70, 7) : answer("finished", 80, 8);
  const fallback = budget();
  const completed = await chat(messages, { budget: fallback, phase: "json_repair" });
  assert.equal(fetched, 2);
  assert.deepEqual(completed.usage, { input: 150, output: 15 });
  assert.deepEqual(fallback.spent, completed.usage);
  assert.deepEqual(completed.calls?.map(call => [call.provider, call.status]), [["selectel", "failed"], ["provod", "succeeded"]]);
  assert.equal(completed.calls?.[0].usageSource, "reported", "empty paid response retains measured usage");

  fetched = 0;
  delete process.env.SELECTEL_API_KEY;
  await assert.rejects(chat(messages), /SELECTEL_API_KEY/);
  assert.equal(fetched, 0, "configuration errors never contact the reserve");
  process.env.SELECTEL_API_KEY = "fixture";

  fetched = 0;
  const tiny = budget(20);
  await assert.rejects(chat(messages, { budget: tiny }), ExecutionBudgetError);
  assert.equal(fetched, 0);
  await assert.rejects(chat(messages, { budget: new ExecutionBudget({ maxTokens: 1000, deadlineAt: Date.now() - 1 }) }),
    (error: unknown) => error instanceof ExecutionBudgetError && error.reason === "deadline");
  assert.equal(fetched, 0);

  const lengthBudget = budget();
  globalThis.fetch = async () => { fetched++; return Response.json({ choices: [{ message: { content: "cut" }, finish_reason: "length" }],
    usage: { prompt_tokens: 90, completion_tokens: 9 } }); };
  await assert.rejects(chat(messages, { budget: lengthBudget }), LlmRequestError);
  assert.equal(fetched, 1, "length is a format failure, not a provider outage");
  assert.deepEqual(lengthBudget.spent, { input: 90, output: 9 });

  fetched = 0;
  const unknown = budget(50_000);
  globalThis.fetch = async () => { fetched++; throw new TypeError("fetch failed"); };
  await assert.rejects(chat(messages, { budget: unknown, maxOutputTokens: 500 }), LlmRequestError);
  assert.equal(fetched, 2);
  assert.deepEqual(unknown.spent, { input: 0, output: 0 });
  assert.ok(unknown.unknownTokens > 1000);
  assert.ok(unknown.calls.every(call => call.status === "unknown" && call.usageSource === "unknown"));

  fetched = 0;
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(chat(messages, { signal: cancelled.signal }),
    (error: unknown) => error instanceof ExecutionBudgetError && error.reason === "cancelled");
  assert.equal(fetched, 0, "an already cancelled run must not send a request");

  process.env.LLM_TIMEOUT_MS = "5";
  globalThis.fetch = async (_url, options) => {
    fetched++;
    return await new Promise<Response>((_resolve, reject) => {
      const signal = options?.signal;
      const watchdog = setTimeout(() => reject(new Error("Fixture request was not cancelled")), 500);
      signal?.addEventListener("abort", () => { clearTimeout(watchdog); reject(signal.reason); }, { once: true });
    });
  };
  const timed = budget();
  await assert.rejects(chat(messages, { budget: timed, maxOutputTokens: 500 }),
    (error: unknown) => error instanceof LlmRequestError && error.reason === "provider_timeout");
  assert.equal(fetched, 2);
  assert.equal(timed.calls[0].completionReason, "provider_timeout");
  delete process.env.LLM_TIMEOUT_MS;

  fetched = 0;
  globalThis.fetch = async () => { fetched++; return Response.json({ choices: [{ message: { content: "estimated" }, finish_reason: "stop" }] }); };
  const estimated = await chat(messages);
  assert.equal(estimated.calls?.[0].usageSource, "estimated");
  assert.ok(estimated.usage.input > 0 && estimated.usage.output > 0);

  const request: AgentRequest = { type: "run", root: "fixture", tarPath: "fixture", systemPrompt: "fixture", userPrompt: "fixture",
    changed: [], model: { baseUrl: "fixture", model: "primary-fixture" }, limits: { maxTokens: 50_000, maxToolCalls: 8, timeoutMs: 60_000 } };
  const reply: AgentReply = { type: "result", text: "", error: null, steps: 1, tokensIn: 100, tokensOut: 20,
    toolCalls: 2, viewed: ["README.md"], skipped: [], partialCopy: null, transcript: "fixture" };
  const execution = budget(60_000);
  let tries = 0;
  const completedRun = await runAgentWithFallback(request, { provider: "selectel", apiKey: "fixture" }, undefined, undefined,
    async (current, _key, _currency, progress) => {
      tries++;
      if (tries === 1) {
        progress?.({ type: "progress", tokensIn: 80, tokensOut: 10 });
        throw new AgentProcessError("ECONNRESET", { input: 100, output: 20 }, 0, "provider_network", 2);
      }
      assert.equal(current.limits.maxTokens, 49_880);
      assert.equal(current.limits.maxToolCalls, 6);
      progress?.({ type: "progress", tokensIn: 80, tokensOut: 10 });
      return { ...reply, text: "finished" };
    }, execution);
  assert.equal(tries, 2);
  assert.deepEqual(execution.spent, { input: 200, output: 40 }, "progress and final usage must be charged once");
  assert.equal(completedRun.run.reply.tokensIn, 200);
  assert.equal(completedRun.run.reply.toolCalls, 4);
  assert.equal(execution.toolCalls, 4);

  tries = 0;
  const failedRuntime = budget();
  await assert.rejects(runAgentWithFallback(request, { provider: "selectel", apiKey: "fixture" }, undefined, undefined,
    async () => {
      if (++tries === 1) return { ...reply, error: "HTTP 503" };
      throw new AgentProcessError("ECONNRESET", { input: 50, output: 5 });
    }, failedRuntime), (error: unknown) => error instanceof AgentProcessError && error.spent.input === 150 && error.spent.output === 25);
  assert.deepEqual(failedRuntime.spent, { input: 150, output: 25 });

  const resumed = createResearchState();
  resumed.notes = "Checked evidence survives provider failure.";
  const modelCall: LlmCallRecord = { id: "model-call-fixture", phase: "research", provider: "agent", model: "fixture",
    startedAt: Date.now(), status: "failed", inputTokens: 100, outputTokens: 20, usageSource: "reported" };
  const observedEvents: unknown[] = [];
  tries = 0;
  const resumedRun = await runAgentWithFallback(request, { provider: "selectel", apiKey: "fixture" }, undefined,
    progress => { if (progress.event) observedEvents.push(progress.event.provider); },
    async (current, _key, _currency, progress) => {
      if (++tries === 1) {
        progress?.({ type: "progress", tokensIn: 100, tokensOut: 20, research: resumed,
          event: { type: "model_call_finished", provider: "agent" }, diagnostics: { version: 1, calls: [modelCall], unknownTokens: 0 } });
        return { ...reply, error: "HTTP 503", diagnostics: { version: 1, calls: [modelCall], unknownTokens: 0 } };
      }
      assert.deepEqual(current.research, resumed);
      return { ...reply, text: "complete", diagnostics: { version: 1, calls: [], unknownTokens: 0 } };
    }, budget());
  assert.deepEqual(observedEvents, ["selectel"]);
  assert.equal(resumedRun.run.reply.diagnostics?.calls[0].provider, "selectel");

  const outputRuntime = new ExecutionBudget({ maxTokens: 60_000, maxOutputChars: 1000,
    deadlineAt: Date.now() + 60_000, maxToolCalls: 8 });
  const outputSnapshot = budget().snapshot();
  tries = 0;
  await runAgentWithFallback({ ...request, limits: { ...request.limits, maxOutputChars: 1000 } },
    { provider: "selectel", apiKey: "fixture" }, undefined, undefined, async (current, _key, _currency, progress) => {
      const diagnostics = { version: 1 as const, calls: [], unknownTokens: 0, budget: { ...outputSnapshot, outputChars: 400 } };
      if (++tries === 1) {
        progress?.({ type: "progress", tokensIn: 100, tokensOut: 20, diagnostics });
        return { ...reply, error: "HTTP 503", diagnostics };
      }
      assert.equal(current.limits.maxOutputChars, 600);
      return { ...reply, text: "complete", diagnostics };
    }, outputRuntime);
  assert.equal(outputRuntime.outputChars, 800, "tool output is counted once across progress, final and reserve");

  const interrupted = budget();
  await assert.rejects(runAgentWithFallback(request, { provider: "selectel", apiKey: "fixture" }, undefined, undefined,
    async (_current, _key, _currency, progress) => {
      progress?.({ type: "progress", tokensIn: 100, tokensOut: 20, diagnostics: { version: 1, unknownTokens: 0,
        calls: [{ ...modelCall, id: "unfinished", status: "started", inputTokens: 0, outputTokens: 0,
          usageSource: "unknown", reservedTokens: 700 }] } });
      throw new AgentProcessError("Process exited", { input: 100, output: 20 });
    }, interrupted), (error: unknown) => error instanceof AgentProcessError && error.unknownTokens === 700);
  assert.equal(interrupted.unknownTokens, 700);
  assert.equal(interrupted.calls[0].status, "unknown");
  assert.deepEqual(interrupted.spent, { input: 100, output: 20 }, "process uncertainty is not fabricated measured usage");

  for (const reason of ["provider_timeout", "cancelled", "deadline"] as const) {
    tries = 0;
    await runAgentWithFallback(request, { provider: "selectel", apiKey: "fixture" }, undefined, undefined,
      async () => {
        tries++;
        return { ...reply, error: tries === 1 ? "Request timed out or aborted" : null,
          diagnostics: { version: 1, reason, calls: [], unknownTokens: 0 } };
      });
    assert.equal(tries, reason === "provider_timeout" ? 2 : 1, "provider timeout may fall back; deadline/cancel may not");
  }
  tries = 0;
  await runAgentWithFallback(request, { provider: "selectel", apiKey: "fixture" }, undefined, undefined,
    async () => { tries++; return { ...reply, error: "Diagnostic persistence acknowledgement timed out" }; });
  assert.equal(tries, 1, "local IPC acknowledgement failure is not a provider failure");

  tries = 0;
  await assert.rejects(runAgentWithFallback({ ...request, limits: { ...request.limits, deadlineAt: Date.now() - 1 } },
    { provider: "selectel", apiKey: "fixture" }, undefined, undefined,
    async () => { tries++; return reply; }, budget()), ExecutionBudgetError);
  assert.equal(tries, 0, "the absolute deadline must survive a different parent budget");

  const calls: LlmCallRecord[] = [];
  const observed = new ExecutionBudget({ maxTokens: 100_000, deadlineAt: Date.now() + 60_000, onCall: call => calls.push(call) });
  globalThis.fetch = async () => answer();
  await chat(messages, { budget: observed });
  assert.deepEqual(calls.map(call => call.status), ["started", "succeeded"]);

  fetched = 0;
  const events: Record<string, unknown>[] = [];
  globalThis.fetch = async () => {
    fetched++;
    assert.equal(events[0]?.type, "model_call_started", "context must be persisted before provider dispatch");
    return answer();
  };
  await chat(messages, { budget: budget(), phase: "verify", onEvent: event => events.push(event) });
  assert.deepEqual(events[0].context, messages);
  assert.equal(events[1].type, "model_call_finished");
  assert.ok(events[1].response);
  assert.ok(!JSON.stringify(events).includes("Authorization"));

  fetched = 0;
  await assert.rejects(chat(messages, { onEvent: () => { throw new Error("Local event store unavailable"); } }), /Local event store unavailable/);
  assert.equal(fetched, 0, "durability failure before dispatch must not trigger provider fallback");

  const failedObserverBudget = budget();
  fetched = 0;
  globalThis.fetch = async () => { fetched++; return answer(); };
  await assert.rejects(chat(messages, { budget: failedObserverBudget, onEvent: event => {
    if (event.type === "model_call_finished") throw new Error("Local event save failed");
  } }), (error: unknown) => error instanceof LlmRequestError && error.reason === "process_failure" && error.usage.input === 100);
  assert.equal(fetched, 1, "a paid response followed by local persistence failure must not trigger provider fallback");
  assert.deepEqual(failedObserverBudget.spent, { input: 100, output: 20 });

  const finding = { prior_id: null, status: "open", area: "code", severity: "important", title: "Grounded fixture",
    description: "Concrete defect", verify: "Check fixture", evidence: "x = 1", impact: "Reproducibility", recommendation: "Fix fixture",
    reason: null, locations: [{ kind: "file", target: "fixture.py", detail: "1" }] };
  const draft = (findings: unknown[]) => JSON.stringify({ summary: "Checked fixture", findings, notes: "Evidence notes" });
  assert.equal((await parseOverviewDraft(draft([finding]), 0)).parsed?.findings.length, 1);
  let repairCalls = 0;
  const forbiddenRepair = async () => { repairCalls++; throw new Error("Semantic errors must not trigger model repair"); };
  for (const broken of [null, {}, { ...finding, title: "" }, { ...finding, severity: "high" }, { ...finding, status: ["open"] },
    { ...finding, evidence: null }, { ...finding, locations: [{ kind: "unknown", target: "fixture.py", detail: "1" }] },
    { ...finding, locations: [{ kind: "file", target: "", detail: "1" }] },
    { ...finding, prior_id: 5, status: "closed", reason: null }]) {
    assert.equal((await parseOverviewDraft(draft([finding, broken]), 100_000, forbiddenRepair)).parsed, null,
      "A malformed finding must invalidate the overview rather than disappear from its findings");
  }
  assert.equal(repairCalls, 0);
  assert.equal((await parseOverviewDraft(JSON.stringify({ findings: [], notes: "Missing summary" }), 100_000, forbiddenRepair)).parsed, null);
  console.log("ok shared runtime budget, paid failures, provider attribution, cache, unknown usage and process fallback");
} finally {
  globalThis.fetch = originalFetch;
}
