import { downloadTextSnapshot } from "@/lib/agent/text-snapshot";
import { fork } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getInstallationToken } from "@/lib/github/auth";
import { openAICompatibleEndpoint } from "@/lib/llm/chat";
import { ExecutionBudget, ExecutionBudgetError, type CompletionReason, type LlmCallRecord } from "@/lib/llm/execution";
import type { AgentLimitsSpec, AgentProgress, AgentReply, AgentRequest } from "@/lib/agent/protocol";
import type { ResearchState } from "@/lib/agent/research";

// Service side of the agent review: downloads the commit archive with the app token, runs
// the agent in a separate process whose environment holds only the model key, enforces the
// time limit and removes the copy afterwards.

const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const CHILD_GRACE_MS = 60_000;
const CHILD_EXIT_WAIT_MS = 5_000;
const CURRENT_CHECK_MS = 5_000;
const TEMP_PREFIX = "curator-agent-";

export interface AgentTarget {
  owner: string;
  repo: string;
  headSha: string;
  installationId: number;
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function agentLimits(): AgentLimitsSpec {
  return {
    maxToolCalls: numberEnv("AGENT_MAX_TOOL_CALLS", 50),
    maxTokens: numberEnv("AGENT_TOKENS_PER_RUN", 600_000),
    timeoutMs: numberEnv("AGENT_TIMEOUT_MS", 10 * 60_000),
  };
}

/** Provider and model of the agent: the review provider, with AGENT_MODEL overriding LLM_MODEL. */
export function agentModel(): { provider: string; baseUrl: string; model: string; apiKey: string } {
  const provider = process.env.LLM_PROVIDER ?? "";
  const endpoint = openAICompatibleEndpoint(provider);
  if (!endpoint) throw new Error(`The agent needs an OpenAI-compatible LLM_PROVIDER, got "${provider}"`);
  if (!endpoint.apiKey) throw new Error(`No API key for provider "${provider}"`);
  const model = process.env.AGENT_MODEL ?? process.env.LLM_MODEL;
  if (!model) throw new Error("AGENT_MODEL or LLM_MODEL must be set for the agent");
  return { provider, baseUrl: endpoint.baseURL, model, apiKey: endpoint.apiKey };
}

class ArchiveTooLarge extends Error {}

async function downloadTarball(target: AgentTarget, dest: string, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<void> {
  const token = await getInstallationToken(target.installationId);
  const response = await fetch(
    `https://api.github.com/repos/${target.owner}/${target.repo}/tarball/${target.headSha}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      // Covers the body as well: a stalled download must not hold the queue.
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Downloading the repository archive failed: ${response.status}`);
  }
  if (Number(response.headers.get("content-length")) > MAX_ARCHIVE_BYTES) {
    await response.body.cancel();
    throw new ArchiveTooLarge("Repository archive exceeds the download limit");
  }
  let received = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      done(received > MAX_ARCHIVE_BYTES ? new ArchiveTooLarge(`Repository archive is larger than ${MAX_ARCHIVE_BYTES} bytes`) : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), limit, createWriteStream(dest));
}

export async function prepareRepositoryArchive(target: AgentTarget, tarPath: string, overview = false, budget?: ExecutionBudget) {
  if (budget && budget.remainingMs <= 0) throw new ExecutionBudgetError("deadline");
  try {
    await downloadTarball(target, tarPath, Math.min(DOWNLOAD_TIMEOUT_MS, budget?.remainingMs ?? DOWNLOAD_TIMEOUT_MS));
  } catch (error) {
    if (!(error instanceof ArchiveTooLarge) || !overview) throw error;
    const token = await getInstallationToken(target.installationId);
    if (budget && budget.remainingMs <= 0) throw new ExecutionBudgetError("deadline");
    return downloadTextSnapshot(`/repos/${target.owner}/${target.repo}`, target.headSha, token, tarPath);
  }
}

/** Environment of the agent process: what Node needs to run and reach the network, plus the model key. */
export function childEnv(apiKey: string): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"];
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const name of keep) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.AGENT_API_KEY = apiKey;
  return env;
}

/** Path of the agent process entry, resolved at run time (it is not part of the server bundle). */
function childEntry(): string {
  return [process.cwd(), "lib", "agent", "child.mts"].join(sep);
}

/**
 * The agent process died, hung or could not be talked to. `spent` is what it reported before
 * that. An interrupted request has a separate conservative allowance; it is not reported as
 * measured provider usage.
 */
export class AgentProcessError extends Error {
  constructor(
    message: string,
    readonly spent: { input: number; output: number },
    readonly unknownTokens = 0,
    readonly reason: CompletionReason = "process_failure",
    readonly toolCalls = 0,
  ) {
    super(message);
  }
}

/** Run the agent process for one request; it is killed if it outlives the time limit. */
export function runAgentProcess(request: AgentRequest, apiKey: string, isCurrent?: () => boolean, onProgress?: (progress: AgentProgress) => void): Promise<AgentReply> {
  return new Promise((resolve, reject) => {
    const child = fork(childEntry(), [], {
      cwd: process.cwd(),
      execArgv: ["--import", "tsx"],
      env: childEnv(apiKey),
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let settled = false;
    let exited = false;
    const spent = { input: 0, output: 0 };
    const exit = new Promise<void>((done) => child.once("exit", () => done()));
    // The caller removes the copy next, so the process must be gone before the promise settles.
    const finish = (error: Error | null, reply?: AgentReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearInterval(currentTimer);
      if (!exited) child.kill("SIGKILL");
      const waited = exited ? Promise.resolve() : Promise.race([exit, sleep(CHILD_EXIT_WAIT_MS)]);
      void waited.then(() => (error ? reject(error) : resolve(reply!)));
    };
    const killTimer = setTimeout(
      () =>
        finish(
          new AgentProcessError(`The agent process did not finish in ${request.limits.timeoutMs + CHILD_GRACE_MS} ms`,
            { ...spent }, Math.max(0, request.limits.maxTokens - spent.input - spent.output), "deadline"),
        ),
      request.limits.timeoutMs + CHILD_GRACE_MS,
    );
    // A new commit or a closed PR cancels the run between agent steps.
    const currentTimer = setInterval(() => {
      try {
        if (isCurrent && !isCurrent() && child.connected) child.send({ type: "cancel" });
      } catch (error) {
        console.warn("[agent] the currency check failed:", error);
      }
    }, CURRENT_CHECK_MS);
    child.on("message", (message: AgentReply | AgentProgress) => {
      if (message.type === "progress") {
        spent.input = message.tokensIn;
        spent.output = message.tokensOut;
        try {
          onProgress?.(message);
          if (message.event?.type === "model_call_started" && typeof message.event.callId === "string" && child.connected) {
            child.send({ type: "progress_ack", callId: message.event.callId });
          }
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      } else if (message.type === "result") {
        finish(null, message);
      }
    });
    child.on("error", (error) => finish(new AgentProcessError(error.message, { ...spent })));
    child.on("exit", () => {
      exited = true;
    });
    // "close" comes after the IPC channel is drained, so a reply sent just before exiting is not lost.
    child.on("close", (code) => finish(new AgentProcessError(`The agent process exited with code ${code}`, { ...spent })));
    child.send(request);
  });
}

export interface AgentRun {
  reply: AgentReply;
  provider: string;
  model: string;
  calls?: LlmCallRecord[];
}

/** Obtain an immutable complete copy without starting an agent or exposing model tools. */
export async function withRepositoryCopy<T>(target: AgentTarget, budget: ExecutionBudget, consume: (root: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    const tarPath = join(dir, "repo.tar.gz"), root = join(dir, "repo");
    const partial = await prepareRepositoryArchive(target, tarPath, true, budget);
    const { mkdir } = await import("node:fs/promises");
    const { extractTarball } = await import("./workspace");
    const { snapshotExclusion } = await import("@/lib/curator/snapshot-policy");
    await mkdir(root);
    const extracted = await extractTarball(tarPath, root);
    if (partial || extracted.stoppedOn || extracted.skipped.some(e => !snapshotExclusion(e.path))) {
      throw new Error("incomplete_snapshot: project audit requires the complete selected snapshot");
    }
    return await consume(root);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/**
 * Run the agent over a copy of the repository at the commit and hand the result, with the
 * copy still on disk, to `use`; the copy is removed afterwards.
 */
export async function withAgentRun<T>(
  target: AgentTarget,
  input: { systemPrompt: string; userPrompt: string; changed: string[]; overview?: boolean; snapshot?: boolean; snapshotParts?: boolean; pipelineScope?: string; legacyOverview?: boolean; research?: ResearchState; onProgress?: (progress: AgentProgress) => void; limits?: AgentLimitsSpec; budget?: ExecutionBudget; reserveTokens?: number },
  consume: (run: AgentRun, root: string) => Promise<T>,
  isCurrent?: () => boolean,
): Promise<T> {
  const { provider, baseUrl, model, apiKey } = agentModel();
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    const tarPath = join(dir, "repo.tar.gz");
    const root = join(dir, "repo");
    const partialCopy = await prepareRepositoryArchive(target, tarPath, input.overview, input.budget);
    if (input.snapshot) {
      if (!input.overview || !input.budget) throw new Error("Initial snapshot requires overview mode and a shared budget");
      const { extractTarball } = await import("@/lib/agent/workspace");
      const { mkdir } = await import("node:fs/promises");
      const { runInitialMap, snapshotExclusion } = await import("@/lib/curator/initial-map");
      await mkdir(root, { recursive: true });
      const extracted = await extractTarball(tarPath, root);
      if (partialCopy || extracted.stoppedOn) throw new Error("Incomplete repository snapshot: " + (partialCopy || extracted.stoppedOn));
      const missingText = extracted.skipped.filter(entry => !snapshotExclusion(entry.path));
      if (missingText.length) throw new Error("Snapshot could not include repository entries: " + JSON.stringify(missingText));
      const progress = (event: Record<string, unknown>) => input.onProgress?.({
        type: "progress", tokensIn: input.budget!.spent.input, tokensOut: input.budget!.spent.output, event,
      });
      const completed = input.snapshotParts
        ? await (await import("@/lib/curator/map-pipeline")).runMapPipeline(root, input.userPrompt, input.budget, progress, {
          revision: target.headSha, scope: input.pipelineScope,
        })
        : await runInitialMap(root, input.userPrompt, input.budget, progress);
      return await consume(completed, root);
    }
    const configured = input.limits ?? agentLimits();
    const limits = input.budget ? { ...configured,
      maxTokens: Math.min(configured.maxTokens, Math.max(0, input.budget.remainingTokens - (input.reserveTokens ?? 0))),
      maxToolCalls: Math.min(configured.maxToolCalls, input.budget.maxToolCalls === undefined ? configured.maxToolCalls : Math.max(0, input.budget.maxToolCalls - input.budget.toolCalls)),
      timeoutMs: Math.min(configured.timeoutMs, input.budget.remainingMs,
        Math.max(0, (configured.deadlineAt ?? input.budget.deadlineAt) - Date.now())),
      deadlineAt: Math.min(input.budget.deadlineAt, configured.deadlineAt ?? input.budget.deadlineAt),
      ...(input.budget.maxOutputChars === undefined ? {} : { maxOutputChars: Math.min(configured.maxOutputChars ?? input.budget.maxOutputChars,
        Math.max(0, input.budget.maxOutputChars - input.budget.outputChars)) }),
    } : configured;
    if (limits.timeoutMs <= 0) throw new ExecutionBudgetError("deadline");
    if (limits.maxTokens <= 0) throw new ExecutionBudgetError("token_limit");
    if (limits.maxToolCalls <= 0) throw new ExecutionBudgetError("tool_limit");
    const request: AgentRequest = {
      type: "run", tarPath, partialCopy, root, systemPrompt: input.systemPrompt, userPrompt: input.userPrompt,
      changed: input.changed, overview: input.overview, legacyOverview: input.legacyOverview,
      research: input.research, model: { baseUrl, model }, limits,
    };
    const completed = await runAgentWithFallback(request, { provider, apiKey }, isCurrent, input.onProgress, runAgentProcess, input.budget);
    return await consume(completed.run, completed.root);
  } finally {
    // A failed removal must not replace the result or the original error.
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch((error) =>
      console.warn(`[agent] failed to remove ${dir}:`, error),
    );
  }
}

/** Retry a gateway failure once, within the original time and token allowance. */
export async function runAgentWithFallback(
  request: AgentRequest,
  primary: { provider: string; apiKey: string },
  isCurrent?: () => boolean,
  onProgress?: (progress: AgentProgress) => void,
  execute = runAgentProcess,
  sharedBudget?: ExecutionBudget,
): Promise<{ run: AgentRun; root: string }> {
  const started = Date.now();
  const budget = sharedBudget ?? new ExecutionBudget({ maxTokens: request.limits.maxTokens,
    deadlineAt: Math.min(started + request.limits.timeoutMs, request.limits.deadlineAt ?? started + request.limits.timeoutMs),
    maxToolCalls: request.limits.maxToolCalls, maxOutputChars: request.limits.maxOutputChars });
  request = { ...request, limits: { ...request.limits,
    maxTokens: Math.min(request.limits.maxTokens, budget.remainingTokens),
    maxToolCalls: Math.min(request.limits.maxToolCalls, budget.maxToolCalls === undefined ? request.limits.maxToolCalls : Math.max(0, budget.maxToolCalls - budget.toolCalls)),
    timeoutMs: Math.min(request.limits.timeoutMs, budget.remainingMs,
      Math.max(0, (request.limits.deadlineAt ?? budget.deadlineAt) - Date.now())),
    deadlineAt: Math.min(budget.deadlineAt, request.limits.deadlineAt ?? budget.deadlineAt),
    ...(budget.maxOutputChars === undefined ? {} : { maxOutputChars: Math.min(request.limits.maxOutputChars ?? budget.maxOutputChars,
      Math.max(0, budget.maxOutputChars - budget.outputChars)) }),
  } };
  if (request.limits.timeoutMs <= 0) throw new ExecutionBudgetError("deadline");
  if (request.limits.maxTokens <= 0) throw new ExecutionBudgetError("token_limit");
  if (request.limits.maxToolCalls <= 0) throw new ExecutionBudgetError("tool_limit");
  const before = { ...budget.spent };
  const initialTools = budget.toolCalls;
  const initialUnknown = budget.unknownTokens;
  const initialOutputChars = budget.outputChars;
  const calls: LlmCallRecord[] = [];
  let evidence = "";
  let research = request.research;
  let primaryException: unknown;
  type WithDiagnostics = AgentReply;
  async function attempt(current: AgentRequest, provider: string, key: string): Promise<AgentReply> {
    let input = 0;
    let output = 0;
    let tools = 0;
    let unknown = 0;
    let outputChars = 0;
    const attemptCallIds = new Set<string>();
    const retain = (diagnostics?: WithDiagnostics["diagnostics"]) => {
      if (!diagnostics) return;
      const nextUnknown = diagnostics.unknownTokens ?? unknown;
      budget.reserveUnknown(Math.max(0, nextUnknown - unknown)); unknown = Math.max(unknown, nextUnknown);
      const nextOutputChars = diagnostics.budget?.outputChars ?? outputChars;
      budget.outputChars += Math.max(0, nextOutputChars - outputChars); outputChars = Math.max(outputChars, nextOutputChars);
      for (const item of diagnostics.calls ?? []) {
        const call = { ...item, provider };
        attemptCallIds.add(call.id);
        const index = calls.findIndex(existing => existing.id === call.id);
        if (index >= 0) calls[index] = call; else calls.push(call);
        budget.recordCall(call);
      }
    };
    const charge = (nextIn: number, nextOut: number, nextTools = tools) => {
      budget.charge({ input: Math.max(0, nextIn - input), output: Math.max(0, nextOut - output) });
      input = Math.max(input, nextIn); output = Math.max(output, nextOut);
      budget.toolCalls += Math.max(0, nextTools - tools); tools = Math.max(tools, nextTools);
    };
    try {
      const result = await execute(current, key, isCurrent, progress => {
        if (progress.evidence) evidence = progress.evidence;
        if (progress.research) research = progress.research;
        charge(progress.tokensIn, progress.tokensOut, (progress as AgentProgress & { toolCalls?: number }).toolCalls);
        retain((progress as AgentProgress & { diagnostics?: WithDiagnostics["diagnostics"] }).diagnostics);
        onProgress?.({ ...progress, event: normalizeProviderEvent(progress.event, provider),
          diagnostics: progress.diagnostics ? { ...progress.diagnostics, calls: calls.map(call => ({ ...call })),
            unknownTokens: budget.unknownTokens - initialUnknown, budget: budget.snapshot() } : undefined,
          toolCalls: budget.toolCalls - initialTools,
          tokensIn: budget.spent.input - before.input, tokensOut: budget.spent.output - before.output });
      });
      charge(result.tokensIn, result.tokensOut, result.toolCalls);
      const diagnostics = (result as WithDiagnostics).diagnostics;
      retain(diagnostics);
      if (result.diagnostics?.research) research = result.diagnostics.research;
      if (result.diagnostics) result.diagnostics = { ...result.diagnostics, calls: calls.map(call => ({ ...call })),
        unknownTokens: budget.unknownTokens - initialUnknown, budget: budget.snapshot() };
      return result;
    } catch (error) {
      const pending = calls.filter(call => attemptCallIds.has(call.id) && call.status === "started");
      const pendingAllowance = pending.reduce((total, call) => total + (call.reservedTokens ?? 0), 0);
      if (error instanceof AgentProcessError) {
        charge(error.spent.input, error.spent.output, error.toolCalls);
      }
      const uncertainty = Math.max(pendingAllowance, error instanceof AgentProcessError ? error.unknownTokens : 0);
      budget.reserveUnknown(Math.max(0, uncertainty - unknown));
      for (const call of pending) {
        call.status = "unknown"; call.endedAt = Date.now();
        call.completionReason = error instanceof AgentProcessError ? error.reason : "process_failure";
        budget.recordCall(call);
      }
      throw error;
    }
  }
  let reply: AgentReply;
  try { reply = await attempt(request, primary.provider, primary.apiKey); }
  catch (error) {
    primaryException = error;
    reply = { type: "result", text: "", error: error instanceof Error ? error.message : String(error),
      tokensIn: budget.spent.input - before.input, tokensOut: budget.spent.output - before.output,
      steps: 0, toolCalls: budget.toolCalls - initialTools, viewed: [], skipped: [], partialCopy: request.partialCopy ?? null, transcript: "" };
  }
  const provider = process.env.LLM_FALLBACK_PROVIDER;
  const endpoint = provider && openAICompatibleEndpoint(provider);
  const remaining = Math.min(budget.remainingTokens, request.limits.maxTokens - reply.tokensIn - reply.tokensOut - (budget.unknownTokens - initialUnknown));
  const timeLeft = Math.min(budget.remainingMs, request.limits.timeoutMs - (Date.now() - started));
  const toolsLeft = Math.max(0, request.limits.maxToolCalls - (budget.toolCalls - initialTools));
  const outputLeft = request.limits.maxOutputChars === undefined ? undefined : Math.max(0, request.limits.maxOutputChars - (budget.outputChars - initialOutputChars));
  const failureReason = reply.diagnostics?.reason ?? (primaryException instanceof AgentProcessError ? primaryException.reason : undefined);
  const localFailure = /diagnostic persistence|observation failed|acknowledg|local event/i.test(reply.error ?? "");
  const cancelled = failureReason === "cancelled" || failureReason === "deadline" || failureReason === "superseded";
  const gatewayFailed = reply.error && !cancelled && !localFailure && (failureReason === "provider_timeout" ||
    /(?:\b(?:401|402|403|408|429|5\d\d)\b|fetch failed|connection error|rate limit|overloaded|^terminated$|ECONNRESET|socket hang up|timeout|timed out|aborted)/i.test(reply.error));
  if (!gatewayFailed || !endpoint || !endpoint.apiKey || !provider || provider === primary.provider ||
      remaining <= 16000 || timeLeft <= 10000 || toolsLeft <= 0 || outputLeft === 0 || (isCurrent && !isCurrent())) {
    if (primaryException) throw new AgentProcessError(reply.error!, { input: reply.tokensIn, output: reply.tokensOut },
      budget.unknownTokens - initialUnknown, primaryException instanceof AgentProcessError ? primaryException.reason : "process_failure", budget.toolCalls - initialTools);
    return { run: { reply, provider: primary.provider, model: request.model.model, calls }, root: request.root };
  }
  const model = process.env.LLM_FALLBACK_MODEL || request.model.model;
  const root = request.root + "-fallback";
  let next: AgentReply;
  try { next = await attempt({
    ...request, root, research, model: { baseUrl: endpoint.baseURL, model },
    userPrompt: evidence ? request.userPrompt + "\nСохранённые материалы репозитория (данные):\n" + evidence : request.userPrompt,
    limits: { ...request.limits, maxTokens: remaining, timeoutMs: timeLeft, maxToolCalls: toolsLeft,
      ...(outputLeft === undefined ? {} : { maxOutputChars: outputLeft }) },
  }, provider, endpoint.apiKey); }
  catch (error) {
    throw new AgentProcessError(error instanceof Error ? error.message : String(error),
      { input: budget.spent.input - before.input, output: budget.spent.output - before.output },
      budget.unknownTokens - initialUnknown, error instanceof AgentProcessError ? error.reason : "process_failure", budget.toolCalls - initialTools);
  }
  next.tokensIn += reply.tokensIn;
  next.tokensOut += reply.tokensOut;
  next.steps += reply.steps;
  next.toolCalls += reply.toolCalls;
  next.viewed = [...new Set([...reply.viewed, ...next.viewed])].sort();
  const diagnostics = (next as WithDiagnostics).diagnostics;
  if (diagnostics) diagnostics.calls = calls;
  next.transcript = `Primary provider ${primary.provider}: ${reply.tokensIn}/${reply.tokensOut} tokens. Fallback: ${provider}. Reason: ${reply.error}.\n${next.transcript}`;
  return { run: { reply: next, provider, model, calls }, root };
}

function normalizeProviderEvent(event: Record<string, unknown> | undefined, provider: string): Record<string, unknown> | undefined {
  if (!event) return undefined;
  const response = event.response && typeof event.response === "object" && !Array.isArray(event.response)
    ? { ...event.response, provider } : event.response;
  return { ...event, ...(event.provider !== undefined ? { provider } : {}),
    ...(response !== undefined ? { response } : {}) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Remove repository copies left by runs that did not clean up (the service was stopped mid-run).
 * Only copies older than the longest possible run are touched.
 */
export async function removeStaleAgentDirs(): Promise<void> {
  const base = tmpdir();
  // Twice the longest run, which leaves room for the verification request after it.
  const maxAgeMs = 2 * (Math.max(agentLimits().timeoutMs, numberEnv("PR_TIMEOUT_MS", 20 * 60000), 20 * 60000) + CHILD_GRACE_MS + DOWNLOAD_TIMEOUT_MS);
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return;
  }
  for (const name of entries) {
    if (![TEMP_PREFIX, "curator-pr-git-", "curator-map-views-"].some(prefix => name.startsWith(prefix))) continue;
    const dir = resolve(base, name);
    if (dirname(dir) !== resolve(base)) continue;
    try {
      const entry = await lstat(dir);
      if (!entry.isDirectory() || entry.isSymbolicLink() || Date.now() - entry.mtimeMs < Math.max(maxAgeMs, 2 * 20 * 60000)) continue;
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      console.log(`[agent] removed a stale repository copy: ${dir}`);
    } catch (error) {
      console.warn(`[agent] failed to remove ${dir}:`, error);
    }
  }
}
