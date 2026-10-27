import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type AssistantMessage,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createToolLog, createTools, type ToolLog } from "@/lib/agent/tools.mjs";

// One agent run: the model reads the repository copy through our tools and ends with the
// review JSON. Bounded by tool calls, tokens and time; cancellable from outside.

/** The agent process reads the model key from this variable and nothing else. */
export const AGENT_KEY_ENV = "AGENT_API_KEY";

export interface AgentModelConfig {
  baseUrl: string;
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface AgentLimits {
  maxToolCalls: number;
  /** Input plus output tokens over all steps. */
  maxTokens: number;
  timeoutMs: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxToolCalls: 50,
  maxTokens: 600_000,
  timeoutMs: 10 * 60_000,
};

/**
 * Every step resends the whole conversation. When the budget left is under this many steps like
 * the last one (a step whose tool calls are refused, the final answer and a margin), tool calls
 * are refused and the model is asked to answer with what it has read.
 */
const WRAP_UP_STEPS = 2.5;

export interface AgentResult {
  /** Text of the final answer; empty when the run failed. */
  text: string;
  error: string | null;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  log: ToolLog;
  /** The whole conversation: model texts, tool calls and tool results. */
  messages: AgentMessage[];
}

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

/** Upper-side token estimate: about three characters per token for mixed Russian and code. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface RunAgentOptions {
  root: string;
  systemPrompt: string;
  userPrompt: string;
  models: Models;
  model: Model<string>;
  limits?: AgentLimits;
  signal?: AbortSignal;
  /** Called after every step with the tokens spent so far. */
  onUsage?: (tokensIn: number, tokensOut: number) => void;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const limits = options.limits ?? DEFAULT_AGENT_LIMITS;
  const log = createToolLog();
  let toolCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let wrapUp = false;
  let stopReason: string | null = null;

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      thinkingLevel: "off",
      tools: createTools(options.root, log),
    },
    streamFn: options.models.streamSimple.bind(options.models),
    convertToLlm: withoutReasoning,
    toolExecution: "sequential",
    beforeToolCall: async () => {
      toolCalls += 1;
      if (toolCalls > limits.maxToolCalls) {
        return { block: true, reason: "Лимит вызовов инструментов исчерпан: ответь итоговым JSON сейчас." };
      }
      if (wrapUp) {
        return { block: true, reason: "Бюджет токенов почти исчерпан: ответь итоговым JSON сейчас по тому, что уже прочитал." };
      }
      return undefined;
    },
  });

  const abort = (reason: string) => {
    stopReason ??= reason;
    agent.abort();
  };
  agent.subscribe((event) => {
    if (event.type !== "turn_end") return;
    const message = event.message as AssistantMessage;
    const before = tokensIn + tokensOut;
    const usage = message.usage;
    if (usage && usage.input + usage.cacheRead + usage.output > 0) {
      tokensIn += usage.input + usage.cacheRead;
      tokensOut += usage.output;
    } else {
      // Without reported usage the budget still holds: a rough estimate from the text size.
      tokensIn += estimateTokens(options.systemPrompt) + estimateTokens(JSON.stringify(agent.state.messages));
      tokensOut += estimateTokens(JSON.stringify(message.content));
    }
    options.onUsage?.(tokensIn, tokensOut);
    const spent = tokensIn + tokensOut;
    if (spent + WRAP_UP_STEPS * (spent - before) > limits.maxTokens) wrapUp = true;
    // The final answer is kept even if its step went over the budget: the run ends with it anyway.
    const final = !message.content.some((p) => p.type === "toolCall");
    if (!final && spent > limits.maxTokens) abort(`token budget of ${limits.maxTokens} exceeded`);
    // A model that keeps calling tools after the limit is stopped for good.
    if (toolCalls > limits.maxToolCalls + 3) abort(`more than ${limits.maxToolCalls} tool calls`);
  });
  const timer = setTimeout(() => abort(`timeout of ${limits.timeoutMs} ms`), limits.timeoutMs);
  const onCancel = () => abort("cancelled");
  options.signal?.addEventListener("abort", onCancel, { once: true });
  if (options.signal?.aborted) onCancel();

  let thrown: string | null = null;
  try {
    await agent.prompt(options.userPrompt);
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
  }

  const assistants = agent.state.messages.filter((m): m is AssistantMessage => m.role === "assistant");
  const last = assistants.at(-1);
  const text = (last?.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("")
    .trim();
  const error =
    stopReason ??
    thrown ??
    last?.errorMessage ??
    agent.state.errorMessage ??
    (text === "" ? "the agent ended without a final answer" : null);
  return {
    text: error ? "" : text,
    error,
    steps: assistants.length,
    tokensIn,
    tokensOut,
    log,
    messages: agent.state.messages,
  };
}
