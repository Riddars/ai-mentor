/** Serializable execution accounting shared by research, summaries and delivery preparation. */
export type CompletionReason =
  | "completed" | "token_limit" | "tool_limit" | "output_limit" | "deadline"
  | "provider_timeout" | "provider_network" | "provider_http" | "invalid_format"
  | "no_progress" | "incomplete_snapshot" | "cancelled" | "superseded"
  | "process_failure" | "interrupted" | "format_error" | "stall" | "context_limit";
export type LlmPhase = "research" | "compact" | "synthesis" | "json_repair" | "verify";
export type UsageSource = "reported" | "estimated" | "unknown";

export interface ExecutionUsage {
  /** Total prompt tokens, including cached input. Cache fields are a breakdown, never added twice. */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  source?: UsageSource;
}

export interface LlmCallRecord {
  id: string;
  phase: LlmPhase;
  provider: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  status: "started" | "succeeded" | "failed" | "unknown";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  usageSource: UsageSource;
  completionReason?: CompletionReason;
  error?: string;
  requestId?: string;
  responseId?: string;
  finishReason?: string;
  inputChars?: number;
  outputChars?: number;
  reservedTokens?: number;
}

export interface ExecutionBudgetSnapshot {
  maxTokens: number;
  deadlineAt: number;
  maxToolCalls?: number;
  maxOutputChars?: number;
  reserveTokens: number;
  spent: { input: number; output: number };
  toolCalls: number;
  outputChars: number;
  /** Conservative allowance for submitted requests whose usage could not be recovered. */
  unknownTokens: number;
  calls: LlmCallRecord[];
}

export interface ExecutionBudgetOptions {
  maxTokens: number;
  deadlineAt: number;
  maxToolCalls?: number;
  maxOutputChars?: number;
  reserveTokens?: number;
  spent?: { input: number; output: number };
  toolCalls?: number;
  outputChars?: number;
  unknownTokens?: number;
  calls?: LlmCallRecord[];
  onCall?: (call: LlmCallRecord) => void;
}

function count(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.ceil(value)) : 0;
}

export class ExecutionBudgetError extends Error {
  constructor(readonly reason: CompletionReason) {
    super(`Execution stopped: ${reason}`);
    this.name = "ExecutionBudgetError";
  }
}
export class ContextWindowError extends ExecutionBudgetError {
  constructor(readonly contextTokens: number) { super("context_limit"); }
}

export class ExecutionBudget {
  readonly maxTokens: number;
  readonly deadlineAt: number;
  readonly maxToolCalls?: number;
  readonly maxOutputChars?: number;
  readonly reserveTokens: number;
  readonly calls: LlmCallRecord[];
  readonly spent: { input: number; output: number };
  toolCalls: number;
  outputChars: number;
  unknownTokens: number;
  private readonly onCall?: (call: LlmCallRecord) => void;

  constructor(options: ExecutionBudgetOptions) {
    if (!Number.isFinite(options.maxTokens) || options.maxTokens <= 0 || !Number.isFinite(options.deadlineAt)) {
      throw new Error("Execution budget needs finite positive tokens and a finite deadline");
    }
    this.maxTokens = count(options.maxTokens);
    this.deadlineAt = options.deadlineAt;
    this.maxToolCalls = options.maxToolCalls === undefined ? undefined : count(options.maxToolCalls);
    this.maxOutputChars = options.maxOutputChars === undefined ? undefined : count(options.maxOutputChars);
    this.reserveTokens = count(options.reserveTokens);
    this.spent = { input: count(options.spent?.input), output: count(options.spent?.output) };
    this.toolCalls = count(options.toolCalls);
    this.outputChars = count(options.outputChars);
    this.unknownTokens = count(options.unknownTokens);
    this.calls = (options.calls ?? []).map(call => ({ ...call }));
    this.onCall = options.onCall;
  }

  get remainingTokens(): number {
    return Math.max(0, this.maxTokens - this.spent.input - this.spent.output - this.unknownTokens);
  }

  get remainingMs(): number { return Math.max(0, this.deadlineAt - Date.now()); }

  admit(request: { inputTokens: number; maxOutputTokens: number; reserveTokens?: number; phase?: LlmPhase; minOutputTokens?: number }):
    { allowed: boolean; reason?: CompletionReason; maxOutputTokens: number } {
    if (this.remainingMs <= 0) return { allowed: false, reason: "deadline", maxOutputTokens: 0 };
    const available = this.remainingTokens - count(request.reserveTokens ?? this.reserveTokens) - count(request.inputTokens);
    const output = Math.min(count(request.maxOutputTokens), Math.max(0, available));
    if (output < Math.min(count(request.maxOutputTokens), count(request.minOutputTokens ?? 256)) || output === 0) {
      return { allowed: false, reason: "token_limit", maxOutputTokens: 0 };
    }
    return { allowed: true, maxOutputTokens: output };
  }

  charge(usage: ExecutionUsage, call?: LlmCallRecord): void {
    this.spent.input += count(usage.input);
    this.spent.output += count(usage.output);
    if (call) this.recordCall(call);
  }

  reserveUnknown(tokens: number): void { this.unknownTokens += count(tokens); }

  consumeTools(amount = 1): CompletionReason | null {
    if (this.maxToolCalls !== undefined && this.toolCalls + count(amount) > this.maxToolCalls) return "tool_limit";
    this.toolCalls += count(amount);
    return null;
  }

  consumeOutput(chars: number): CompletionReason | null {
    if (this.maxOutputChars !== undefined && this.outputChars + count(chars) > this.maxOutputChars) return "output_limit";
    this.outputChars += count(chars);
    return null;
  }

  recordCall(call: LlmCallRecord): void {
    const index = this.calls.findIndex(item => item.id === call.id);
    if (index >= 0) this.calls[index] = { ...call };
    else this.calls.push({ ...call });
    this.onCall?.({ ...call });
  }

  snapshot(): ExecutionBudgetSnapshot {
    return { maxTokens: this.maxTokens, deadlineAt: this.deadlineAt, maxToolCalls: this.maxToolCalls,
      maxOutputChars: this.maxOutputChars, reserveTokens: this.reserveTokens, spent: { ...this.spent },
      toolCalls: this.toolCalls, outputChars: this.outputChars, unknownTokens: this.unknownTokens,
      calls: this.calls.map(call => ({ ...call })) };
  }
}
