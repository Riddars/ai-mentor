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
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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
}

/** A model answer together with who actually produced it (the fallback may have). */
export interface ChatResult {
  content: string;
  provider: string;
  model: string;
  /** Token counts as reported by the provider, or estimated from the text size. */
  usage: ChatUsage;
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
): Promise<{ content: string; usage: ChatUsage }> {
  const conn = OPENAI_COMPATIBLE[target.provider];
  if (!conn) {
    throw new Error(`Unknown or unsupported LLM provider: "${target.provider}"`);
  }
  const apiKey = process.env[conn.keyEnv];
  if (!apiKey) {
    throw new Error(`${conn.keyEnv} is not set for provider "${target.provider}"`);
  }

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
      max_tokens: numberEnv("LLM_MAX_TOKENS", 8000),
      temperature: Number(process.env.LLM_TEMPERATURE ?? "0.2"),
      // Router-style switch (selectel, openrouter); sent only when explicitly disabled.
      ...(process.env.LLM_REASONING === "off" ? { reasoning: { enabled: false } } : {}),
    }),
    // A hung provider must not keep the required check "in progress" forever.
    signal: AbortSignal.timeout(numberEnv("LLM_TIMEOUT_MS", 300_000)),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`LLM ${target.provider} ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    console.warn("[llm] empty response metadata:", JSON.stringify(emptyResponseMetadata(
      target.provider, target.model, data,
      response.headers.get("x-gateway-request-id") ?? response.headers.get("x-request-id"),
    )));
    throw new Error(`LLM ${target.provider} returned an empty response`);
  }
  if (choice?.finish_reason === "length") {
    throw new Error(`LLM ${target.provider} answer was cut off by the token limit`);
  }
  const usage = data.usage
    ? { input: data.usage.prompt_tokens ?? 0, output: data.usage.completion_tokens ?? 0 }
    : { input: estimateTokens(JSON.stringify(messages)), output: estimateTokens(content) };
  return { content, usage };
}

/** Rough token count of a text, for providers that do not report usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Вызвать одного провайдера. Сюда добавится ветка на anthropic (своя схема). */
async function callTarget(target: Target, messages: ChatMessage[]): Promise<ChatResult> {
  const { content, usage } = await callOpenAICompatible(target, messages);
  return { content, provider: target.provider, model: target.model, usage };
}

/**
 * Единственная точка обращения к языковой модели. Провайдер и модель — из
 * окружения (LLM_PROVIDER / LLM_MODEL). Если задан резерв (LLM_FALLBACK_PROVIDER)
 * и основной провайдер не ответил — один раз пробуем резерв.
 */
export async function chat(messages: ChatMessage[]): Promise<ChatResult> {
  const primary = primaryTarget();
  try {
    return await callTarget(primary, messages);
  } catch (error) {
    const fallback = fallbackTarget();
    if (!fallback) {
      throw error;
    }
    console.warn(
      `[llm] основной провайдер ${primary.provider} не ответил, пробуем резерв ${fallback.provider}:`,
      error,
    );
    return await callTarget(fallback, messages);
  }
}
