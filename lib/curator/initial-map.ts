import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listRepoFiles } from "@/lib/agent/workspace";
import type { AgentRun } from "@/lib/agent/run";
import { snapshotExclusion } from "./snapshot-policy";
export { snapshotExclusion } from "./snapshot-policy";
import { notebookCells } from "@/lib/curator/notebook";
import { initialMapPrompt } from "@/lib/curator/prompts";
import { chat, type ChatMessage, type ChatOptions, type ChatResult } from "@/lib/llm/chat";
import { ExecutionBudget } from "@/lib/llm/execution";

/** No excerpts: every admitted text file appears in full, once. */
export async function buildInitialSnapshot(root: string) {
  const included: Array<{ path: string; chars: number }> = [];
  const excluded: Array<{ path: string; reason: string; bytes: number }> = [];
  const blocks: string[] = [];
  let chars = 0;
  for (const file of await listRepoFiles(root)) {
    const reason = snapshotExclusion(file.path);
    if (reason) { excluded.push({ path: file.path, reason, bytes: file.size }); continue; }
    if (file.size > 2_000_000) throw new Error(`Snapshot text file too large; nothing was truncated: ${file.path}`);
    const bytes = await readFile(join(root, file.path));
    let content: string;
    try {
      if (bytes.includes(0)) throw new Error("binary");
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch { excluded.push({ path: file.path, reason: "двоичный или не UTF-8 файл", bytes: file.size }); continue; }
    if (/\.ipynb$/i.test(file.path)) {
      const cells = notebookCells(content);
      if (cells === null) throw new Error(`Invalid notebook: ${file.path}`);
      content = cells; // All code/markdown cells, no embedded images or execution outputs.
    }
    chars += content.length;
    if (chars > 2_000_000) throw new Error("Snapshot too large; no partial input was submitted");
    included.push({ path: file.path, chars: content.length });
    blocks.push(`=== FILE ${JSON.stringify(file.path)} ===\n${content}\n=== END FILE ===`);
  }
  if (!included.length) throw new Error("No eligible text files for the project map");
  return { included, excluded, chars, text: blocks.join("\n\n") };
}

export async function runInitialMap(root: string, task: string, budget: ExecutionBudget,
  onEvent: (event: Record<string, unknown>) => void,
  ask: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult> = chat): Promise<AgentRun> {
  const snapshot = await buildInitialSnapshot(root);
  const messages: ChatMessage[] = [{ role: "system", content: initialMapPrompt() },
    { role: "user", content: task + "\nИсключённые файлы (содержимое не передано):\n" + JSON.stringify(snapshot.excluded) + "\n\n" + snapshot.text }];
  const estimatedInput = Math.ceil(JSON.stringify(messages).length / 3);
  const contextTokens = Number(process.env.INITIAL_MAP_CONTEXT_TOKENS ?? 128_000);
  const metadata = { included: snapshot.included, excluded: snapshot.excluded, chars: snapshot.chars, estimatedInput, contextTokens };
  onEvent({ type: "initial_snapshot", ...metadata });
  if (!Number.isFinite(contextTokens) || contextTokens < 16_000 || estimatedInput + 8_000 > contextTokens) {
    throw new Error(`Snapshot does not fit declared context: estimated input ${estimatedInput}, output reserve 8000, context ${contextTokens}. Nothing truncated or sent.`);
  }
  const answer = await ask(messages, { budget, phase: "synthesis", maxOutputTokens: 8000, onEvent });
  return { provider: answer.provider, model: answer.model, calls: answer.calls,
    reply: { type: "result", text: answer.content, error: null, steps: 1,
      tokensIn: answer.usage.input, tokensOut: answer.usage.output, toolCalls: 0,
      viewed: snapshot.included.map(file => file.path), skipped: [], partialCopy: null, partialReview: false,
      transcript: "Карта проекта: один запрос с полным содержимым отобранных файлов, без инструментов.\n" + JSON.stringify(metadata),
      diagnostics: { version: 1, reason: "completed", calls: budget.calls, unknownTokens: budget.unknownTokens,
        budget: budget.snapshot(), snapshot: metadata } } };
}
