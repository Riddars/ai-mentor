// Messages between the service and the agent process. Kept free of dependencies so the
// service side does not load the agent libraries.
import type { ResearchState } from "@/lib/agent/research";
import type { CompletionReason, ExecutionBudgetSnapshot, LlmCallRecord } from "@/lib/llm/execution";

export interface AgentDiagnostics {
  version: 1;
  reason?: CompletionReason;
  calls: LlmCallRecord[];
  unknownTokens: number;
  research?: ResearchState;
  budget?: ExecutionBudgetSnapshot;
}

export interface AgentModelSpec {
  baseUrl: string;
  model: string;
  contextWindow?: number;
}

export interface AgentLimitsSpec {
  deadlineAt?: number;
  maxOutputChars?: number;
  maxToolCalls: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface AgentRequest {
  type: "run";
  /** Downloaded GitHub tarball to unpack into `root`. */
  tarPath: string;
  partialCopy?: string;
  root: string;
  systemPrompt: string;
  /** The review prompt; the repository map is appended by the agent process. */
  userPrompt: string;
  /** Paths changed by the PR: their imports are suggested to the agent. */
  changed: string[];
  overview?: boolean;
  legacyOverview?: boolean;
  research?: ResearchState;
  model: AgentModelSpec;
  limits: AgentLimitsSpec;
}

export interface AgentCancel {
  type: "cancel";
}

/** Tokens spent so far, sent after every agent step. */
export interface AgentProgress {
  type: "progress";
  evidence?: string;
  research?: ResearchState;
  event?: Record<string, unknown>;
  diagnostics?: AgentDiagnostics;
  toolCalls?: number;
  tokensIn: number;
  tokensOut: number;
}

export interface AgentReply {
  type: "result";
  text: string;
  error: string | null;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  viewed: string[];
  /** Entries of the archive that were not unpacked, and why. */
  skipped: Array<{ path: string; reason: string }>;
  partialCopy: string | null;
  partialReview?: boolean;
  diagnostics?: AgentDiagnostics;
  /** The run step by step as Markdown (lib/agent/transcript.mts), for the supervisor. */
  transcript: string;
}
