import type { ChatUsage } from "@/lib/llm/chat";

/** Tokens and rubles of one or more model calls. */
export interface Spend extends ChatUsage {
  /** Rubles for the priced calls. */
  rub: number;
  /** True when some call with tokens had no price. */
  unpriced: boolean;
  /** Provider of the last call with tokens. */
  provider: string | null;
}

interface Price {
  input: number;
  output: number;
}

/**
 * Prices from LLM_PRICES, rubles per million tokens: `provider:model=input/output`, entries
 * separated by ";", e.g. `selectel:deepseek/deepseek-v4-pro=21.672/43.345`.
 */
function parsePrices(raw: string | undefined): Map<string, Price> {
  const prices = new Map<string, Price>();
  for (const entry of (raw ?? "").split(";")) {
    const colon = entry.indexOf(":");
    const eq = entry.lastIndexOf("=");
    if (colon < 0 || eq < colon) continue;
    const [input, output] = entry.slice(eq + 1).split("/").map(Number);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    prices.set(`${entry.slice(0, colon).trim()}:${entry.slice(colon + 1, eq).trim()}`, { input, output });
  }
  return prices;
}

/** Rubles for the tokens of one call; null when the model has no price. */
export function priceRub(usage: ChatUsage, provider: string, model: string): number | null {
  const price = parsePrices(process.env.LLM_PRICES).get(`${provider}:${model}`);
  return price ? (usage.input * price.input + usage.output * price.output) / 1_000_000 : null;
}

export function emptySpend(): Spend {
  return { input: 0, output: 0, rub: 0, unpriced: false, provider: null };
}

/** Add one call's tokens to `total`, priced by its provider and model. */
export function addSpend(total: Spend, usage: ChatUsage, provider: string, model: string): Spend {
  if (usage.input + usage.output === 0) return total;
  total.input += usage.input;
  total.output += usage.output;
  total.provider = provider;
  const rub = priceRub(usage, provider, model);
  if (rub === null) total.unpriced = true;
  else total.rub += rub;
  return total;
}

export function mergeSpend(total: Spend, other: Spend): Spend {
  if (other.input + other.output === 0) return total;
  total.input += other.input;
  total.output += other.output;
  total.rub += other.rub;
  total.unpriced ||= other.unpriced;
  total.provider = other.provider ?? total.provider;
  return total;
}

/** Rubles to store with an analysis: null when unknown (some tokens had no price). */
export function spendRub(spend: Spend): number | null {
  if (spend.input + spend.output === 0) return 0;
  return spend.unpriced ? null : spend.rub;
}
