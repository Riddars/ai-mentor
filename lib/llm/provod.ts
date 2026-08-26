import { getConfig } from "@/lib/config";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Обращение к языковой модели через provod.ai — российский OpenAI-совместимый
 * шлюз (оплата в рублях, ключ вида sk_...). Разбор pull request — фоновая разовая
 * задача, поэтому стриминг не нужен: берём ответ целиком из тела /chat/completions.
 * Точный id модели — из GET {baseUrl}/models; дефолт задаётся PROVOD_MODEL.
 */
export async function provodChat(messages: ChatMessage[]): Promise<string> {
  const { provodApiKey, provodModel, provodBaseUrl } = getConfig();
  if (!provodApiKey) {
    throw new Error("PROVOD_API_KEY is not set");
  }

  const response = await fetch(`${provodBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provodApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provodModel,
      messages,
      stream: false,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Provod ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("Provod returned an empty response");
  }
  return content;
}
