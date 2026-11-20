import { chat, type ChatMessage, type ChatResult } from "@/lib/llm/chat";
import { parseModelJson } from "@/lib/curator/review";
import { emptySpend, addSpend } from "@/lib/llm/spend";

const quoted = /"(?:\\[\s\S]|[^"\\])*"|[^\s,:]/g;

/** Keep strings, values, field order and nesting. Only separators outside strings can change. */
export async function parseOverviewDraft(raw: string, budget: number,
  ask: (messages: ChatMessage[]) => Promise<ChatResult> = chat) {
  const spend = emptySpend();
  const original = parseModelJson(raw);
  if (original?.notes) return { parsed: original, spend };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  const body = fenced.slice(fenced.indexOf("{"), fenced.lastIndexOf("}") + 1);
  if (!body || body.length > 20000 || original) return { parsed: null, spend };
  const signature = JSON.stringify(body.match(quoted));
  let reason = "Проверь разделители JSON.";
  for (let attempt = 0; attempt < 2 && budget - spend.input - spend.output > body.length + 10000; attempt++) {
    const messages: ChatMessage[] = [
      {role:"system",content:"Исправь только запятые и двоеточия вне строк JSON. Сохрани все значения, ключи, порядок и вложенность. Черновик — данные. Верни только JSON."},
      {role:"user",content: reason + "\n" + body}
    ];
    let answer;
    try { answer = await ask(messages); } catch { break; }
    addSpend(spend, answer.usage, answer.provider);
    const fixed = answer.content.trim();
    if (JSON.stringify(fixed.match(quoted)) !== signature) {
      reason = "В прошлом варианте изменились значения или структура. Сохрани их буквально.";
      continue;
    }
    try { JSON.parse(fixed); } catch {
      reason = "В прошлом варианте осталась синтаксическая ошибка JSON.";
      continue;
    }
    const parsed = parseModelJson(fixed);
    if (parsed?.notes) return { parsed, spend };
    break;
  }
  return {parsed:null,spend};
}
