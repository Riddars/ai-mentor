import { randomUUID } from "node:crypto";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { Type, createAssistantMessageEventStream, type AssistantMessage, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { withoutReasoning } from "./pi-model.mts";
import { createWholeFileReader, type ReadWholeFileResult } from "./whole-file-reader";
import type { ReviewRepository } from "@/lib/curator/pr-full-diff";
import { measureContext, type ContextLimits } from "@/lib/curator/context-size";
import { ContextWindowError, ExecutionBudget, ExecutionBudgetError, type CompletionReason, type LlmCallRecord } from "@/lib/llm/execution";

export interface PrAgentTarget {
  provider: string;
  model: Model<string>;
  stream: StreamFn;
  apiKey?: string;
  contextTokens: number;
}
export interface PrAgentCheckpoint { messages: AgentMessage[]; finalising: boolean }
export interface PrContextAgentOptions {
  repository: ReviewRepository;
  systemPrompt: string;
  userPrompt: string;
  primary: PrAgentTarget;
  fallback?: PrAgentTarget;
  budget: ExecutionBudget;
  outputTokens?: number;
  futureReserve: number;
  checkpoint?: PrAgentCheckpoint;
  onCheckpoint?(checkpoint: PrAgentCheckpoint): void;
  onEvent?(event: Record<string, unknown>): void;
}
export interface PrContextAgentResult {
  text: string; error: string | null; reason: CompletionReason | null;
  contextTokens?: number;
  retryable?: boolean;
  checkpoint: PrAgentCheckpoint;
  files: ReadWholeFileResult[];
  denied: ReadWholeFileResult[];
  modelCalls: number;
}
function errorStream(model: Model<string>, reason: string) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error", errorMessage: reason, timestamp: Date.now() };
  stream.push({ type: "error", reason: "error", error: message }); stream.end(message); return stream;
}
function providerFailure(message: string): CompletionReason {
  return /\b[45]\d\d\b/.test(message) ? "provider_http" : /timeout|timed.out/i.test(message) ? "provider_timeout" : "provider_network";
}
/** Dedicated Pi loop: original diff and full files remain in the transcript, no research ledger. */
export async function runPrContextAgent(options: PrContextAgentOptions): Promise<PrContextAgentResult> {
  const outputTokens = options.outputTokens ?? 4000;
  const limits: ContextLimits = { contextTokens: options.primary.contextTokens, outputTokens, safetyRatio: 0.15 };
  let finalising = options.checkpoint?.finalising ?? false;
  let finalMessageAdded = (options.checkpoint?.messages ?? []).some(m => m.role === "system" && m.toolsRemoved?.some(t => t.name === "read_file"));
  let error: string | null = null, reason: CompletionReason | null = null, contextTokens: number | undefined;
  let modelCalls = 0;
  let retryable = true;
  let currentContext: unknown = {};
  const pendingToolResults: AgentMessage[] = [];
  let activeToolId = "";
  const available = new Map<string, ReadWholeFileResult>();
  // Only full results actually present in the restored transcript count as already available.
  for (const message of options.checkpoint?.messages ?? []) {
    if (message.role !== "toolResult" || message.toolName !== "read_file") continue;
    try {
      const value = JSON.parse(message.content.filter(c => c.type === "text").map(c => c.type === "text" ? c.text : "").join("")) as ReadWholeFileResult;
      if (value.status === "ok" && typeof value.text === "string") available.set(JSON.stringify([value.path, value.revision]), value);
    } catch { throw new Error("Invalid full-file checkpoint"); }
  }
  const reader = createWholeFileReader({ repository: options.repository, budget: options.budget, limits, available,
    withResult: result => {
      const context = currentContext as { messages?: AgentMessage[]; tools?: unknown };
      const present = new Set((context.messages ?? []).filter(m => m.role === "toolResult").map(m => m.role === "toolResult" ? m.toolCallId : ""));
      return { ...context, messages: [...(context.messages ?? []), ...pendingToolResults.filter(m => m.role === "toolResult" && !present.has(m.toolCallId)),
        { role: "toolResult", toolCallId: activeToolId, toolName: "read_file", content: [{ type: "text", text: JSON.stringify(result) }],
          isError: result.status === "denied", timestamp: Date.now() }] };
    }, futureReserve: () => options.futureReserve });
  const parameters = Type.Object({ path: Type.String(), revision: Type.Optional(Type.Union([Type.Literal("head"), Type.Literal("base")])) }, { additionalProperties: false });
  const tool: AgentTool<typeof parameters> = { name: "read_file", label: "Прочитать файл целиком",
    description: "Read an entire tracked text file. revision=head (default) or base (merge-base). No line ranges. If refused, finish with explicit uncertainty.", parameters,
    async execute(id, args) {
      activeToolId = id;
      const result = await reader.read(args.path, args.revision);
      pendingToolResults.push({ role: "toolResult", toolCallId: id, toolName: "read_file", content: [{ type: "text", text: JSON.stringify(result) }],
        isError: result.status === "denied", timestamp: Date.now() });
      if (result.status === "denied" || reader.stalled) finalising = true;
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined, isError: result.status === "denied" };
    } };
  const emit = (event: Record<string, unknown>) => { try { options.onEvent?.(event); } catch { throw new ExecutionBudgetError("process_failure"); } };
  const snapshot = (): PrAgentCheckpoint => ({ messages: structuredClone(agent.state.messages), finalising });
  const makeCall = async (target: PrAgentTarget, context: TranscriptContext, streamOptions?: SimpleStreamOptions) => {
    const measured = measureContext(context, { ...limits, contextTokens: target.contextTokens });
    if (!measured.fits) throw new ContextWindowError(target.contextTokens);
    const reserve = options.futureReserve + (finalising ? measured.required : 2 * measured.required);
    const admission = options.budget.admit({ inputTokens: measured.inputTokens + measured.allowance, maxOutputTokens: outputTokens, reserveTokens: reserve });
    if (!admission.allowed) throw new ExecutionBudgetError(admission.reason!);
    const call: LlmCallRecord = { id: randomUUID(), phase: finalising ? "synthesis" : "research", provider: target.provider, model: target.model.id,
      startedAt: Date.now(), status: "started", inputTokens: 0, outputTokens: 0, usageSource: "unknown", reservedTokens: measured.inputTokens + measured.allowance + admission.maxOutputTokens };
    options.budget.recordCall(call);
    emit({ type: "model_call_started", callId: call.id, provider: target.provider, model: target.model.id, phase: call.phase });
    modelCalls++;
    try {
      const stream = await target.stream(target.model, context, { ...streamOptions, apiKey: target.apiKey,
        maxTokens: admission.maxOutputTokens, maxRetries: 0, timeoutMs: Math.min(120000, options.budget.remainingMs) });
      const answer = await stream.result();
      const usage = answer.usage;
      const failed = answer.stopReason === "error" || answer.stopReason === "aborted";
      const contextRejected = failed && /context_length|context.window|maximum context|prompt.too.long/i.test(answer.errorMessage ?? "");
      const httpRejected = failed && /\b[45]\d\d\b/.test(answer.errorMessage ?? "");
      const reported = usage && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
      call.inputTokens = reported ? usage.input + usage.cacheRead + usage.cacheWrite : failed ? 0 : measured.inputTokens;
      call.outputTokens = reported ? usage.output : failed ? 0 : Math.ceil(Buffer.byteLength(JSON.stringify(answer.content)) / 2);
      const unknown = failed && !reported && !contextRejected && !httpRejected;
      call.usageSource = reported ? "reported" : unknown ? "unknown" : "estimated";
      call.status = unknown ? "unknown" : failed ? "failed" : "succeeded"; call.endedAt = Date.now(); call.error = answer.errorMessage; call.finishReason = answer.stopReason;
      if (failed) call.completionReason = contextRejected ? "context_limit" : providerFailure(answer.errorMessage ?? "");
      if (unknown) options.budget.reserveUnknown(call.reservedTokens!);
      options.budget.charge({ input: call.inputTokens, output: call.outputTokens }, call);
      emit({ type: "model_call_finished", callId: call.id, provider: target.provider, status: call.status, inputTokens: call.inputTokens, outputTokens: call.outputTokens });
      if (contextRejected) throw new ContextWindowError(target.contextTokens);
      return { stream, answer };
    } catch (failure) {
      if (call.status === "started") {
        call.status = "unknown"; call.endedAt = Date.now(); call.error = "provider stream failed";
        options.budget.reserveUnknown(call.reservedTokens!); options.budget.recordCall(call);
      }
      throw failure;
    }
  };
  const stream: StreamFn = async (_model, context, streamOptions) => {
    currentContext = context;
    try {
      let response;
      let usedFallback = false;
      try { response = await makeCall(options.primary, context, streamOptions); }
      catch (failure) {
        if (failure instanceof ExecutionBudgetError || !options.fallback || streamOptions?.signal?.aborted) throw failure;
        usedFallback = true; response = await makeCall(options.fallback, context, streamOptions);
      }
      if ((response.answer.stopReason === "error" || response.answer.stopReason === "aborted") && !usedFallback && options.fallback && !streamOptions?.signal?.aborted) {
        response = await makeCall(options.fallback, context, streamOptions);
      }
      if (response.answer.stopReason === "error" || response.answer.stopReason === "aborted") {
        error = response.answer.errorMessage ?? "provider stream failed";
        reason = options.budget.remainingMs <= 0 ? "deadline" : providerFailure(error);
        retryable = !/\b(?:400|401|402|403|404|422)\b/.test(error);
      }
      return response.stream;
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : String(failure);
      reason = failure instanceof ExecutionBudgetError ? failure.reason : providerFailure(detail);
      retryable = !/\b(?:400|401|402|403|404|422)\b/.test(detail);
      contextTokens = failure instanceof ContextWindowError ? failure.contextTokens : undefined;
      error = detail;
      return errorStream(options.primary.model, reason);
    }
  };
  const agent = new Agent({ initialState: { systemPrompt: options.systemPrompt, model: options.primary.model, thinkingLevel: "off", tools: [tool],
    ...(options.checkpoint ? { messages: options.checkpoint.messages } : {}) }, streamFn: stream, convertToLlm: withoutReasoning, toolExecution: "sequential",
    prepareRequest: async ({ context }) => {
      currentContext = context;
      const measured = measureContext({ messages: withoutReasoning(context.messages), tools: [parameters] }, limits);
      if (reader.stalled || options.budget.remainingTokens < 4 * measured.required + options.futureReserve) finalising = true;
      if (finalising && !finalMessageAdded) {
        finalMessageAdded = true;
        return { context: { tools: [], messages: [...context.messages, { role: "system" as const, toolsRemoved: [{ name: "read_file" }], timestamp: Date.now(),
          content: "Инструменты отключены. Заверши итоговый JSON по доступным данным. Укажи непроверенные вопросы; не объявляй ограниченный разбор полным." }] } };
      }
      return undefined;
    },
    beforeToolCall: async ({ context }) => {
      currentContext = context;
      if (finalising) return { block: true, reason: "Finish the review with explicit unresolved questions", terminate: true };
      return undefined;
    },
  });
  agent.subscribe(event => { if (event.type === "turn_end") { pendingToolResults.length = 0; options.onCheckpoint?.(snapshot()); } });
  const timer = setTimeout(() => agent.abort(), Math.max(1, options.budget.remainingMs));
  try {
    const last = agent.state.messages.at(-1);
    if (options.checkpoint && last?.role === "assistant" && ["stop", "length"].includes(last.stopReason)) {
      // Response already durable; caller may still need to validate/save it after a crash.
    } else if (options.checkpoint) {
      if (last?.role === "assistant" && ["error", "aborted"].includes(last.stopReason)) agent.state.messages = agent.state.messages.slice(0, -1);
      await agent.continue();
    } else await agent.prompt(options.userPrompt);
  } finally { clearTimeout(timer); }
  const assistant = [...agent.state.messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");
  if (assistant?.stopReason === "length") { reason = "output_limit"; error = "provider answer truncated at output limit"; }
  if (!error && (assistant?.stopReason === "error" || assistant?.stopReason === "aborted")) { reason = options.budget.remainingMs <= 0 ? "deadline" : "provider_network"; error = reason; }
  return { text: assistant?.content.filter(c => c.type === "text").map(c => c.type === "text" ? c.text : "").join("\n") ?? "", error, reason, contextTokens, retryable,
    checkpoint: snapshot(), files: [...available.values()], denied: reader.denied, modelCalls };
}
