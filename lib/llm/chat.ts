import { randomUUID } from "node:crypto";
import { measureContext } from "@/lib/curator/context-size";
import { ContextWindowError } from "@/lib/llm/execution";
import { ExecutionBudget, ExecutionBudgetError, type CompletionReason, type LlmCallRecord, type LlmPhase, type UsageSource } from "@/lib/llm/execution";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface OpenAICompatProvider {
  baseURL: string;
  keyEnv: string;
}

/**
 * OpenAI-совместимые шлюзы: адрес API и переменная с ключом. Добавить такого
 * провайдера — одна строка. Claude (Anthropic) сюда НЕ входит: у него своя схема
 * запросов, он подключается отдельной веткой в `callTarget`, когда понадобится.
 * Провайдер намеренно не зафиксирован — см. `docs/документация/принятые решения.md`.
 */
const OPENAI_COMPATIBLE: Record<string, OpenAICompatProvider> = {
  provod: { baseURL: "https://api.provod.ai/v1", keyEnv: "PROVOD_API_KEY" },
  selectel: { baseURL: "https://api.selectel.ru/aig/v1", keyEnv: "SELECTEL_API_KEY" },
  openai: { baseURL: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
};

/** Address and key of an OpenAI-compatible provider; null for an unknown one. */
export function openAICompatibleEndpoint(provider: string): { baseURL: string; apiKey: string | undefined } | null {
  const entry = OPENAI_COMPATIBLE[provider];
  return entry ? { baseURL: entry.baseURL, apiKey: process.env[entry.keyEnv] } : null;
}

/** Дефолтная модель провайдера, если LLM_MODEL / LLM_FALLBACK_MODEL не заданы. */
const DEFAULT_MODEL: Record<string, string> = {
  provod: "deepseek/deepseek-v4-pro",
  selectel: "deepseek/deepseek-v4-flash",
};

interface Target {
  provider: string;
  model: string;
}

function primaryTarget(): Target {
  const provider = process.env.LLM_PROVIDER;
  if (!provider) {
    throw new Error("LLM_PROVIDER is not set");
  }
  const model = process.env.LLM_MODEL ?? DEFAULT_MODEL[provider] ?? "";
  if (!model) {
    throw new Error(`LLM_MODEL is not set and no default exists for provider "${provider}"`);
  }
  return { provider, model };
}

function fallbackTarget(): Target | null {
  const provider = process.env.LLM_FALLBACK_PROVIDER;
  if (!provider) {
    return null;
  }
  const model = process.env.LLM_FALLBACK_MODEL ?? DEFAULT_MODEL[provider] ?? "";
  if (!model) {
    return null;
  }
  return { provider, model };
}

interface ChatCompletionResponse {
  id?: string;
  choices?: { message?: { content?: unknown; reasoning_content?: unknown; refusal?: unknown; tool_calls?: unknown }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number; prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } };
}

/** Metadata only: never log model text, prompts, keys or the raw response. */
export function emptyResponseMetadata(
  provider: string,
  model: string,
  data: ChatCompletionResponse,
  gatewayRequestId?: string | null,
): Record<string, unknown> {
  const choice = data.choices?.[0];
  const message = choice?.message;
  const safeId = (value: string | null | undefined) => value?.slice(0, 120).replace(/[^a-zA-Z0-9._:-]/g, "?") ?? null;
  return {
    provider,
    model,
    responseId: safeId(data.id),
    gatewayRequestId: safeId(gatewayRequestId),
    choiceCount: data.choices?.length ?? 0,
    finishReason: choice?.finish_reason ?? null,
    contentType: typeof message?.content,
    contentLength: typeof message?.content === "string" ? message.content.length : null,
    hasReasoningContent: typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0,
    hasRefusal: message?.refusal != null,
    hasToolCalls: Array.isArray(message?.tool_calls) && message.tool_calls.length > 0,
    usage: data.usage ? {
      input: data.usage.prompt_tokens ?? null,
      output: data.usage.completion_tokens ?? null,
    } : null,
  };
}

export interface ChatUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  source?: UsageSource;
}

/** A model answer together with who actually produced it (the fallback may have). */
export interface ChatResult {
  content: string;
  provider: string;
  model: string;
  /** Token counts as reported by the provider, or estimated from the text size. */
  usage: ChatUsage;
  calls?: LlmCallRecord[];
}

export interface ChatOptions {
  /** Opt-in admission for the context pipeline; legacy callers retain their current behavior. */
  contextTokens?: number;
  fallbackContextTokens?: number;
  budget?: ExecutionBudget;
  phase?: LlmPhase;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  reserveTokens?: number;
  onCall?: (call: LlmCallRecord) => void;
  onEvent?: (event: Record<string, unknown>) => void;
}

class LlmObserverError extends Error {
  constructor(error: unknown) {
    super(`LLM observation failed: ${error instanceof Error ? error.message : String(error)}`);
    this.name = "LlmObserverError";
  }
}

export class LlmRequestError extends Error {
  constructor(message: string, readonly reason: CompletionReason, readonly retryable: boolean,
    readonly usage: ChatUsage = { input: 0, output: 0 }, readonly calls: LlmCallRecord[] = [], readonly contextTokens?: number) {
    super(message);
    this.name = "LlmRequestError";
  }
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Обращение к OpenAI-совместимому шлюзу (provod, selectel, openai, openrouter).
 * Разбор pull request — фоновая разовая задача, поэтому стриминг не нужен: берём
 * ответ целиком из тела /chat/completions. Точный id модели — из GET {baseURL}/models.
 */
async function callOpenAICompatible(
  target: Target,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<{ content: string; usage: ChatUsage; call: LlmCallRecord }> {
  const conn = OPENAI_COMPATIBLE[target.provider];
  if (!conn) {
    throw new Error(`Unknown or unsupported LLM provider: "${target.provider}"`);
  }
  const apiKey = process.env[conn.keyEnv];
  if (!apiKey) {
    throw new Error(`${conn.keyEnv} is not set for provider "${target.provider}"`);
  }

  if (options.signal?.aborted) throw new ExecutionBudgetError("cancelled");
  const inputChars = JSON.stringify(messages).length;
  const measured = options.contextTokens === undefined ? null : measureContext(messages, {
    contextTokens: options.contextTokens, outputTokens: options.maxOutputTokens ?? 8000,
  });
  if (measured && !measured.fits) throw new ContextWindowError(options.contextTokens!);
  const inputEstimate = measured ? measured.inputTokens + measured.allowance : estimateTokens(JSON.stringify(messages));
  const admission = options.budget?.admit({ inputTokens: inputEstimate,
    maxOutputTokens: options.maxOutputTokens ?? numberEnv("LLM_MAX_TOKENS", 8000),
    reserveTokens: options.reserveTokens, phase: options.phase });
  if (admission && !admission.allowed) throw new ExecutionBudgetError(admission.reason!);
  const maxOutput = admission?.maxOutputTokens ?? options.maxOutputTokens ?? numberEnv("LLM_MAX_TOKENS", 8000);
  const call: LlmCallRecord = { id: randomUUID(), phase: options.phase ?? "research", ...target,
    startedAt: Date.now(), status: "started", inputTokens: 0, outputTokens: 0,
    usageSource: "unknown", inputChars, reservedTokens: inputEstimate + maxOutput };
  const record = () => { options.budget?.recordCall(call); options.onCall?.({ ...call }); };
  const emit = (event: Record<string, unknown>) => {
    try { options.onEvent?.(event); } catch (error) { throw new LlmObserverError(error); }
  };
  record();
  try {
    emit({ type: "model_call_started", callId: call.id, phase: call.phase, provider: call.provider,
      model: call.model, context: messages, maxOutputTokens: maxOutput, startedAt: call.startedAt });
  } catch (error) {
    call.status = "failed"; call.endedAt = Date.now(); call.completionReason = "process_failure";
    call.error = error instanceof Error ? error.message : String(error);
    record();
    throw error;
  }
  const timeout = Math.max(1, Math.min(numberEnv("LLM_TIMEOUT_MS", 300_000), options.budget?.remainingMs ?? Number.MAX_SAFE_INTEGER));
  const timeoutSignal = AbortSignal.timeout(timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let usage: ChatUsage = { input: 0, output: 0, source: "unknown" };
  let responseReceived = false;
  let responseUsageKnown = false;
  let rawResponse: ChatCompletionResponse | undefined;
  try {
  const response = await fetch(`${conn.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: target.model,
      messages,
      stream: false,
      max_tokens: maxOutput,
      temperature: Number(process.env.LLM_TEMPERATURE ?? "0.2"),
      // Router-style switch (selectel, openrouter); sent only when explicitly disabled.
      ...(process.env.LLM_REASONING === "off" ? { reasoning: { enabled: false } } : {}),
    }),
    // A hung provider must not keep the required check "in progress" forever.
    signal,
  });
  responseReceived = true;
  call.requestId = safeId(response.headers.get("x-gateway-request-id") ?? response.headers.get("x-request-id"));
  if (!response.ok) {
    let detail = "";
    if (response.status === 400 || response.status === 413) {
      const reader = response.body?.getReader();
      if (reader) {
        try {
          let bytes = 0;
          while (bytes < 8192) { const chunk = await reader.read(); if (chunk.done) break;
            detail += new TextDecoder().decode(chunk.value.subarray(0, 8192 - bytes)); bytes += chunk.value.length; }
        } finally { await reader.cancel().catch(() => {}); }
      }
    } else await response.body?.cancel();
    if (/context_length_exceeded|context_window_exceeded|max_context_length|prompt_too_long|maximum context length|context window.{0,30}exceed/i.test(detail)) {
      throw new LlmRequestError(`LLM ${target.provider} rejected context size`, "context_limit", false,
        { input: 0, output: 0 }, [], options.contextTokens);
    }
    throw new LlmRequestError(`LLM ${target.provider} HTTP ${response.status}`, "provider_http",
      [401, 402, 403, 408, 409, 429].includes(response.status) || response.status >= 500);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  rawResponse = data;
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  const reported = data.usage;
  const reportedInput = reported?.prompt_tokens;
  const reportedOutput = reported?.completion_tokens;
  usage = {
    input: validCount(reportedInput) ? reportedInput : inputEstimate,
    output: validCount(reportedOutput) ? reportedOutput : estimateTokens(typeof content === "string" ? content : ""),
    cacheRead: reported?.prompt_tokens_details?.cached_tokens ?? reported?.prompt_cache_hit_tokens,
    cacheWrite: reported?.prompt_tokens_details?.cache_write_tokens,
    source: validCount(reportedInput) && validCount(reportedOutput) ? "reported" : "estimated",
  };
  responseUsageKnown = true;
  options.budget?.charge(usage);
  call.inputTokens = usage.input;
  call.outputTokens = usage.output;
  call.cacheReadTokens = usage.cacheRead;
  call.cacheWriteTokens = usage.cacheWrite;
  call.usageSource = usage.source!;
  call.responseId = safeId(data.id);
  call.finishReason = choice?.finish_reason;
  call.outputChars = typeof content === "string" ? content.length : 0;
  if (typeof content !== "string" || content.trim() === "") {
    console.warn("[llm] empty response metadata:", JSON.stringify(emptyResponseMetadata(
      target.provider, target.model, data,
      response.headers.get("x-gateway-request-id") ?? response.headers.get("x-request-id"),
    )));
    throw new LlmRequestError(`LLM ${target.provider} returned an empty response`, "invalid_format", true, usage);
  }
  if (choice?.finish_reason === "length") {
    throw new LlmRequestError(`LLM ${target.provider} answer was cut off by the token limit`, "invalid_format", false, usage);
  }
  call.status = "succeeded";
  call.completionReason = "completed";
  call.endedAt = Date.now();
  record();
  emit({ type: "model_call_finished", callId: call.id, phase: call.phase, provider: call.provider,
    model: call.model, status: call.status, usageSource: call.usageSource, usage,
    durationMs: call.endedAt - call.startedAt, finishReason: call.finishReason, response: data });
  return { content, usage, call };
  } catch (error) {
    const cancelled = options.signal?.aborted;
    const reason: CompletionReason = cancelled ? "cancelled" : timeoutSignal.aborted
      ? (options.budget?.remainingMs === 0 ? "deadline" : "provider_timeout")
      : error instanceof LlmObserverError ? "process_failure"
      : error instanceof LlmRequestError ? error.reason : "provider_network";
    const unknown = !responseUsageKnown && !(error instanceof LlmRequestError &&
      (error.reason === "provider_http" || (responseReceived && error.reason === "context_limit")));
    if (unknown) options.budget?.reserveUnknown(inputEstimate + maxOutput);
    call.status = unknown ? "unknown" : "failed";
    call.completionReason = reason;
    call.error = error instanceof Error ? error.message.slice(0, 500) : "Provider request failed";
    call.endedAt = Date.now();
    record();
    let observerFailed = error instanceof LlmObserverError;
    try {
      emit({ type: rawResponse ? "model_call_finished" : "model_call_failed", callId: call.id,
        phase: call.phase, provider: call.provider, model: call.model, status: call.status,
        reason, error: call.error, usageSource: call.usageSource, usage,
        durationMs: call.endedAt - call.startedAt, ...(rawResponse ? { response: rawResponse } : {}) });
    } catch (eventError) {
      observerFailed = true;
      call.completionReason = "process_failure";
      call.error = eventError instanceof Error ? eventError.message : String(eventError);
      record();
    }
    throw new LlmRequestError(call.error!, observerFailed ? "process_failure" : reason,
      !observerFailed && !cancelled && reason !== "deadline" &&
      (error instanceof LlmRequestError ? error.retryable : !responseReceived || reason === "provider_timeout"), usage, [{ ...call }],
      error instanceof LlmRequestError ? error.contextTokens : undefined);
  }
}

function validCount(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function safeId(value: string | null | undefined): string | undefined {
  return value?.slice(0, 120).replace(/[^a-zA-Z0-9._:-]/g, "?") || undefined;
}

/** Rough token count of a text, for providers that do not report usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Вызвать одного провайдера. Сюда добавится ветка на anthropic (своя схема). */
async function callTarget(target: Target, messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
  const { content, usage, call } = await callOpenAICompatible(target, messages, options);
  return { content, provider: target.provider, model: target.model, usage, calls: [call] };
}

/**
 * Единственная точка обращения к языковой модели. Провайдер и модель — из
 * окружения (LLM_PROVIDER / LLM_MODEL). Если задан резерв (LLM_FALLBACK_PROVIDER)
 * и основной провайдер не ответил — один раз пробуем резерв.
 */
export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
  const primary = primaryTarget();
  try {
    return await callTarget(primary, messages, options);
  } catch (error) {
    const fallback = fallbackTarget();
    if (!fallback || !(error instanceof LlmRequestError) || !error.retryable || options.signal?.aborted ||
      (fallback.provider === primary.provider && fallback.model === primary.model)) {
      throw error;
    }
    console.warn(
      `[llm] основной провайдер ${primary.provider} не ответил, пробуем резерв ${fallback.provider}:`,
      error.reason,
    );
    try {
      const answer = await callTarget(fallback, messages, { ...options, contextTokens: options.fallbackContextTokens ?? options.contextTokens });
      return { ...answer, usage: { input: error.usage.input + answer.usage.input,
        output: error.usage.output + answer.usage.output }, calls: [...error.calls, ...(answer.calls ?? [])] };
    } catch (next) {
      if (next instanceof LlmRequestError) throw new LlmRequestError(next.message, next.reason, false,
        { input: error.usage.input + next.usage.input, output: error.usage.output + next.usage.output }, [...error.calls, ...next.calls], next.contextTokens);
      throw new LlmRequestError(next instanceof Error ? next.message : String(next),
        next instanceof ExecutionBudgetError ? next.reason : "provider_network", false, error.usage, error.calls,
        next instanceof ContextWindowError ? next.contextTokens : undefined);
    }
  }
}
