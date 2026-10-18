import type { ChatUsage } from "@/lib/llm/chat";

/** Tokens of one or more model calls. */
export interface Spend extends ChatUsage {
  /** Provider of the last call with tokens. */
  provider: string | null;
}

export function emptySpend(): Spend {
  return { input: 0, output: 0, provider: null };
}

/** Add one call's tokens to `total`. */
export function addSpend(total: Spend, usage: ChatUsage, provider: string): Spend {
  if (usage.input + usage.output === 0) return total;
  total.input += usage.input;
  total.output += usage.output;
  total.provider = provider;
  return total;
}

export function mergeSpend(total: Spend, other: Spend): Spend {
  if (other.input + other.output === 0) return total;
  total.input += other.input;
  total.output += other.output;
  total.provider = other.provider ?? total.provider;
  return total;
}
