// Messages between the service and the agent process. Kept free of dependencies so the
// service side does not load the agent libraries.

export interface AgentModelSpec {
  baseUrl: string;
  model: string;
  contextWindow?: number;
}

export interface AgentLimitsSpec {
  maxToolCalls: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface AgentRequest {
  type: "run";
  /** Downloaded GitHub tarball to unpack into `root`. */
  tarPath: string;
  root: string;
  systemPrompt: string;
  /** The review prompt; the repository map is appended by the agent process. */
  userPrompt: string;
  /** Paths changed by the PR: their imports are suggested to the agent. */
  changed: string[];
  model: AgentModelSpec;
  limits: AgentLimitsSpec;
}

export interface AgentCancel {
  type: "cancel";
}

/** Tokens spent so far, sent after every agent step. */
export interface AgentProgress {
  type: "progress";
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
}
