import assert from "node:assert/strict";
import { chat, LlmRequestError } from "@/lib/llm/chat";
import { ContextWindowError, ExecutionBudget } from "@/lib/llm/execution";
Object.assign(process.env, { LLM_PROVIDER: "selectel", LLM_MODEL: "fixture", SELECTEL_API_KEY: "fixture",
  LLM_FALLBACK_PROVIDER: "provod", LLM_FALLBACK_MODEL: "fixture", PROVOD_API_KEY: "fixture" });
let calls = 0;
globalThis.fetch = async () => { calls++; return Response.json({ error: "unavailable" }, { status: 503 }); };
const messages = [{ role: "user" as const, content: "x".repeat(10000) }];
const budget = new ExecutionBudget({ maxTokens: 100000, deadlineAt: Date.now() + 60000 });
await assert.rejects(chat(messages, { budget, contextTokens: 128000, fallbackContextTokens: 1200, maxOutputTokens: 100 }),
  (error: unknown) => error instanceof LlmRequestError && error.reason === "context_limit" && error.contextTokens === 1200);
assert.equal(calls, 1, "smaller fallback rejected locally before network");
assert.equal(budget.unknownTokens, 0);
calls = 0;
await assert.rejects(chat(messages, { contextTokens: 1200, maxOutputTokens: 100 }), ContextWindowError);
assert.equal(calls, 0, "oversized primary rejected before any call");
delete process.env.LLM_FALLBACK_PROVIDER;
globalThis.fetch = async () => { calls++; return Response.json({ error: { code: "context_length_exceeded" } }, { status: 400 }); };
await assert.rejects(chat(messages, { budget, contextTokens: 128000, maxOutputTokens: 100 }),
  (error: unknown) => error instanceof LlmRequestError && error.reason === "context_limit");
assert.equal(calls, 1);
assert.equal(budget.unknownTokens, 0, "explicit rejected HTTP context is not mistaken for unknown completed generation");
console.log("ok context transport: primary/fallback admission before network, failing model window preserved, explicit API rejection typed without unknown model spend");
