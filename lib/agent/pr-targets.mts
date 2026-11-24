import { openAICompatibleEndpoint } from "@/lib/llm/chat";
import { openAICompatibleModel } from "./pi-model.mts";
import type { PrAgentTarget } from "./pr-context-agent.mjs";

const positive = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
};
export function configuredPrTargets() {
  const build = (provider: string, model: string, contextTokens: number): PrAgentTarget => {
    const endpoint = openAICompatibleEndpoint(provider);
    if (!endpoint?.apiKey || !model) throw new Error(`Model configuration unavailable: ${provider}`);
    const configured = openAICompatibleModel({ model, baseUrl: endpoint.baseURL, contextWindow: contextTokens, maxOutputTokens: 8000 });
    return { provider, model: configured.model, apiKey: endpoint.apiKey, contextTokens, stream: configured.models.streamSimple.bind(configured.models) };
  };
  const primary = build(process.env.LLM_PROVIDER ?? "selectel", process.env.LLM_MODEL ?? "deepseek/deepseek-v4-flash",
    positive("PR_CONTEXT_TOKENS", positive("INITIAL_MAP_CONTEXT_TOKENS", 128000)));
  const fallback = process.env.LLM_FALLBACK_PROVIDER ? build(process.env.LLM_FALLBACK_PROVIDER,
    process.env.LLM_FALLBACK_MODEL ?? "deepseek/deepseek-v4-pro", positive("LLM_FALLBACK_CONTEXT_TOKENS", primary.contextTokens)) : undefined;
  const runLimit = Number(process.env.PR_TOKENS_PER_RUN ?? 950000);
  if (!Number.isSafeInteger(runLimit) || runLimit < 0) throw new Error("Invalid PR_TOKENS_PER_RUN");
  return { primary, fallback, maxTokens: runLimit || Number.MAX_SAFE_INTEGER, timeoutMs: positive("PR_TIMEOUT_MS", 20 * 60000) };
}
