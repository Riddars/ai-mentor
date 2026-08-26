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
  choices?: { message?: { content?: string } }[];
}

/**
 * Обращение к OpenAI-совместимому шлюзу (provod, selectel, openai, openrouter).
 * Разбор pull request — фоновая разовая задача, поэтому стриминг не нужен: берём
 * ответ целиком из тела /chat/completions. Точный id модели — из GET {baseURL}/models.
 */
async function callOpenAICompatible(
  target: Target,
  messages: ChatMessage[],
): Promise<string> {
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
    body: JSON.stringify({ model: target.model, messages, stream: false }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`LLM ${target.provider} ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error(`LLM ${target.provider} returned an empty response`);
  }
  return content;
}

/** Вызвать одного провайдера. Сюда добавится ветка на anthropic (своя схема). */
function callTarget(target: Target, messages: ChatMessage[]): Promise<string> {
  return callOpenAICompatible(target, messages);
}

/**
 * Единственная точка обращения к языковой модели. Провайдер и модель — из
 * окружения (LLM_PROVIDER / LLM_MODEL). Если задан резерв (LLM_FALLBACK_PROVIDER)
 * и основной провайдер не ответил — один раз пробуем резерв.
 */
export async function chat(messages: ChatMessage[]): Promise<string> {
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
