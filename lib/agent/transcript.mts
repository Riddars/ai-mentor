import type { AgentMessage } from "@earendil-works/pi-agent-core";

// The agent conversation as Markdown, for diagnosing a run: what the model wrote, which
// tools it called and what came back.

const TOOL_RESULT_CHARS = 3_000;

function fence(text: string): string {
  return `\`\`\`\`\n${text}\n\`\`\`\``;
}

export function transcript(title: string, messages: AgentMessage[], notes: string[] = []): string {
  const out = [`# ${title}`];
  let step = 0;
  for (const m of messages) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      out.push("## Запрос", fence(text));
    } else if (m.role === "assistant") {
      step += 1;
      const usage = m.usage ? ` (вход ${m.usage.input + m.usage.cacheRead}, выход ${m.usage.output})` : "";
      out.push(`## Шаг ${step}${usage}`);
      for (const part of m.content) {
        if (part.type === "text" && part.text.trim()) out.push(part.text.trim());
        if (part.type === "thinking" && part.thinking.trim()) out.push(`Размышления:\n${fence(part.thinking.trim())}`);
        if (part.type === "toolCall") out.push(`→ \`${part.name}\` ${JSON.stringify(part.arguments)}`);
      }
      if (m.errorMessage) out.push(`Ошибка: ${m.errorMessage}`);
    } else if (m.role === "toolResult") {
      const text = m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      const cut =
        text.length > TOOL_RESULT_CHARS ? `${text.slice(0, TOOL_RESULT_CHARS)}\n…(обрезано, всего ${text.length} символов)` : text;
      out.push(`← \`${m.toolName}\`${m.isError ? " (ошибка)" : ""}`, fence(cut));
    }
  }
  if (notes.length > 0) out.push("## Итог", ...notes.map((n) => `- ${n}`));
  return `${out.join("\n\n")}\n`;
}
