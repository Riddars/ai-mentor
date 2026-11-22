import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createModels, createProvider, envApiKeyAuth, type Model, type Message } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { AgentModelConfig } from './agent.mjs';
const AGENT_KEY_ENV = 'AGENT_API_KEY';

type Models = ReturnType<typeof createModels>;

/** An OpenAI-compatible endpoint (e.g. the Selectel router) as a pi provider. */
export function openAICompatibleModel(config: AgentModelConfig): { models: Models; model: Model<"openai-completions"> } {
  const model: Model<"openai-completions"> = {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: "agent",
    baseUrl: config.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow ?? 128_000,
    maxTokens: config.maxOutputTokens ?? 8_000,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      // Sends `reasoning: { enabled: false }` at the "off" thinking level.
      thinkingFormat: "together",
    },
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "agent",
      baseUrl: config.baseUrl,
      auth: { apiKey: envApiKeyAuth("Agent model key", [AGENT_KEY_ENV]) },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  return { models, model };
}

/**
 * Drops replayed reasoning from the history: routers reject reasoning blocks sent back
 * together with the reasoning switch, and the review does not need them.
 */
export function withoutReasoning(messages: AgentMessage[]): Message[] {
  return messages
    .filter(
      (m): m is Message => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult",
    )
    .map((m) => {
      if (m.role !== "assistant") return m;
      const content = m.content
        .filter((p) => p.type !== "thinking")
        .map((p) => {
          if (p.type !== "toolCall") return p;
          const call = { ...p };
          delete call.thoughtSignature;
          return call;
        });
      return { ...m, content };
    });
}
