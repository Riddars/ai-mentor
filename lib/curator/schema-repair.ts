import type { ChatMessage, ChatOptions, ChatResult } from "@/lib/llm/chat";
import type { ExecutionBudget } from "@/lib/llm/execution";
import { measureContext, type ContextLimits } from "./context-size";
import type { PipelineStore } from "./pipeline-store";

/** At most two repairs across restarts; only the answer/schema, never repository contents. */
export async function repairSchema<T>(initial: ChatResult, decode: (raw: string) => T | null, options: {
  id: string; hash: string; schema: string; limits: ContextLimits; budget: ExecutionBudget; reserve: number;
  store: PipelineStore; ask: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult>; fallbackContextTokens?: number;
  validationError?: (raw: string) => string;
}): Promise<{ answer: ChatResult; value: T | null }> {
  const saved = options.store.load("format-state:" + options.id, options.hash);
  let state = saved ? JSON.parse(saved.content) as { attempts: number; answer: ChatResult } : { attempts: 0, answer: initial };
  let value = decode(state.answer.content);
  while (value === null && state.attempts < 2) {
    const messages: ChatMessage[] = [{ role: "system", content: "Исправь JSON и все нарушения схемы. Не добавляй фактов и не меняй выводы. Строки, превышающие лимит, обязательно перефразируй короче, сохранив существенные факты. Простое повторение прежнего ответа не исправляет превышение. Схема и ошибки проверки:\n" + options.schema + "\n" + (options.validationError?.(state.answer.content) ?? "Ответ не прошёл проверку схемы.") },
      { role: "user", content: state.answer.content }];
    if (!measureContext(messages, options.limits).fits) break;
    state = { ...state, attempts: state.attempts + 1 };
    // Persist before the external call: a crash cannot reset the repair allowance.
    const persist = () => options.store.save("format-state:" + options.id, options.hash, { content: JSON.stringify(state), provider: "internal", model: "format-state", usage: { input: 0, output: 0 } });
    persist();
    state.answer = await options.ask(messages, { budget: options.budget, phase: "json_repair", maxOutputTokens: options.limits.outputTokens,
      reserveTokens: options.reserve, contextTokens: options.limits.contextTokens, fallbackContextTokens: options.fallbackContextTokens });
    persist(); value = decode(state.answer.content);
  }
  return { answer: state.answer, value };
}
