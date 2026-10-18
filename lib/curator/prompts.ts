import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { databasePath } from "@/lib/config";

// Prompts are Markdown files in prompts/. A file may include another one or a value passed by
// the caller with {{name}}. The core (what is and is not a finding) can be replaced from the
// panel: the edited text lives next to the database and wins over prompts/core.md until reset.

export const CORE_MAX_CHARS = 20_000;

const PLACEHOLDER = /\{\{([a-z-]+)\}\}/g;

function readText(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n").trimEnd();
}

function defaultPath(name: string): string {
  // turbopackIgnore: prompts are read at run time, not bundled.
  return resolve(/* turbopackIgnore: true */ process.cwd(), "prompts", `${name}.md`);
}

function customCorePath(): string {
  const db = resolve(/* turbopackIgnore: true */ process.cwd(), databasePath());
  return join(dirname(db), "prompts", "core.md");
}

function customCore(): string | null {
  try {
    return readText(customCorePath());
  } catch {
    return null;
  }
}

/** A prompt file with its {{...}} resolved; an edited core is used as written. */
function render(name: string, values: Record<string, string> = {}): string {
  if (name === "core") {
    const custom = customCore();
    if (custom !== null) return custom;
  }
  return readText(defaultPath(name)).replace(PLACEHOLDER, (_, key: string) =>
    key in values ? values[key] : render(key, values),
  );
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

export interface CorePrompt {
  text: string;
  defaultText: string;
  custom: boolean;
}

export function getCorePrompt(): CorePrompt {
  const defaultText = readText(defaultPath("core"));
  const custom = customCore();
  return { text: custom ?? defaultText, defaultText, custom: custom !== null };
}

export function saveCorePrompt(text: string): void {
  const path = customCorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${text.trimEnd()}\n`, "utf8");
}

export function resetCorePrompt(): void {
  rmSync(customCorePath(), { force: true });
}
