/** Admission is deliberately separate from the provider's billed usage. */
export interface ContextLimits {
  contextTokens: number;
  outputTokens: number;
  headroomTokens?: number;
  safetyRatio?: number;
}
export interface TokenCounter {
  name: string;
  exact: boolean;
  count(serializedRequest: string): number;
}
export const estimatedCounter: TokenCounter = {
  name: "utf8-bytes/2-estimate-v1", exact: false,
  count: text => Math.ceil(Buffer.byteLength(text, "utf8") / 2),
};
export function measureContext(request: unknown, limits: ContextLimits, counter = estimatedCounter) {
  const { contextTokens, outputTokens, headroomTokens = 0, safetyRatio = 0.15 } = limits;
  if (![contextTokens, outputTokens, headroomTokens, safetyRatio].every(Number.isFinite) ||
    contextTokens <= 0 || outputTokens <= 0 || headroomTokens < 0 || safetyRatio < 0 || safetyRatio >= 1) {
    throw new Error("Invalid context limits");
  }
  const serialized = JSON.stringify(request);
  if (serialized === undefined) throw new Error("Request is not serializable");
  const inputTokens = counter.count(serialized);
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new Error("Invalid token counter result");
  // Even a matching tokenizer may not account for the provider's hidden message framing.
  const allowance = Math.ceil(inputTokens * safetyRatio);
  const required = inputTokens + allowance + outputTokens + headroomTokens;
  return { fits: required <= contextTokens, inputTokens, required, allowance,
    counter: counter.name, estimated: !counter.exact, bytes: Buffer.byteLength(serialized, "utf8") };
}
