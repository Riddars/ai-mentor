import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Prompts are Markdown files in prompts/. A file may include another one or a value passed by
// the caller with {{name}}.

const PLACEHOLDER = /\{\{([a-z-]+)\}\}/g;

/** A prompt file with its {{...}} resolved. */
function render(name: string, values: Record<string, string> = {}): string {
  // turbopackIgnore: prompts are read at run time, not bundled.
  const path = resolve(/* turbopackIgnore: true */ process.cwd(), "prompts", `${name}.md`);
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n").trimEnd();
  return text.replace(PLACEHOLDER, (_, key: string) => (key in values ? values[key] : render(key, values)));
}

/** System prompt of a PR review. */
export function reviewPrompt(): string {
  return render("review", { notes: '"полный новый текст заметок о проекте или null"' });
}

/** System prompt of a full project overview. */
export function overviewPrompt(): string {
  return render("overview", { notes: '"полный текст заметок о проекте"' });
}

/** Rules appended to the review prompt when the model works over a repository copy. */
export function agentRules(): string {
  return render("agent");
}

/** System prompt of the second look at new findings. */
export function verifyPrompt(): string {
  return render("verify");
}
