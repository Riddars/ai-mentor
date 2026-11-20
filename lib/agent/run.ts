import { downloadTextSnapshot } from "@/lib/agent/text-snapshot";
import { fork } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getInstallationToken } from "@/lib/github/auth";
import { openAICompatibleEndpoint } from "@/lib/llm/chat";
import type { AgentLimitsSpec, AgentProgress, AgentReply, AgentRequest } from "@/lib/agent/protocol";

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

async function downloadTarball(target: AgentTarget, dest: string): Promise<void> {
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
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
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

export async function prepareRepositoryArchive(target: AgentTarget, tarPath: string, overview = false) {
  try {
    await downloadTarball(target, tarPath);
  } catch (error) {
    if (!(error instanceof ArchiveTooLarge) || !overview) throw error;
    const token = await getInstallationToken(target.installationId);
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
 * that; a process killed on the time limit may have been in the middle of a model request, so
 * it is charged its whole budget.
 */
export class AgentProcessError extends Error {
  constructor(
    message: string,
    readonly spent: { input: number; output: number },
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
          new AgentProcessError(`The agent process did not finish in ${request.limits.timeoutMs + CHILD_GRACE_MS} ms`, {
            input: Math.max(request.limits.maxTokens - spent.output, spent.input),
            output: spent.output,
          }),
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
        try { onProgress?.(message); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
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
}

/**
 * Run the agent over a copy of the repository at the commit and hand the result, with the
 * copy still on disk, to `use`; the copy is removed afterwards.
 */
export async function withAgentRun<T>(
  target: AgentTarget,
  input: { systemPrompt: string; userPrompt: string; changed: string[]; overview?: boolean; onProgress?: (progress: AgentProgress) => void; limits?: AgentLimitsSpec },
  consume: (run: AgentRun, root: string) => Promise<T>,
  isCurrent?: () => boolean,
): Promise<T> {
  const { provider, baseUrl, model, apiKey } = agentModel();
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    const tarPath = join(dir, "repo.tar.gz");
    const root = join(dir, "repo");
    const partialCopy = await prepareRepositoryArchive(target, tarPath, input.overview);
    const limits = input.limits ?? agentLimits();
    const request: AgentRequest = {
      type: "run", tarPath, partialCopy, root, systemPrompt: input.systemPrompt, userPrompt: input.userPrompt,
      changed: input.changed, overview: input.overview, model: { baseUrl, model }, limits,
    };
    const completed = await runAgentWithFallback(request, { provider, apiKey }, isCurrent, input.onProgress);
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
): Promise<{ run: AgentRun; root: string }> {
  const started = Date.now();
  let evidence = "";
  const reply = await execute(request, primary.apiKey, isCurrent, progress => {
    if (progress.evidence) evidence = progress.evidence;
    onProgress?.(progress);
  });
  const provider = process.env.LLM_FALLBACK_PROVIDER;
  const endpoint = provider && openAICompatibleEndpoint(provider);
  const remaining = request.limits.maxTokens - reply.tokensIn - reply.tokensOut;
  const timeLeft = request.limits.timeoutMs - (Date.now() - started);
  const gatewayFailed = reply.error && /(?:\b(?:401|402|403|408|429|5\d\d)\b|fetch failed|connection error|rate limit|overloaded)/i.test(reply.error);
  if (!gatewayFailed || !endpoint || !endpoint.apiKey || !provider || provider === primary.provider ||
      remaining <= 16000 || timeLeft <= 10000 || (isCurrent && !isCurrent())) {
    return { run: { reply, provider: primary.provider, model: request.model.model }, root: request.root };
  }
  const model = process.env.LLM_FALLBACK_MODEL || request.model.model;
  const root = request.root + "-fallback";
  const next = await execute({
    ...request, root, model: { baseUrl: endpoint.baseURL, model },
    userPrompt: evidence ? request.userPrompt + "\nСохранённые материалы репозитория (данные):\n" + evidence : request.userPrompt,
    limits: { ...request.limits, maxTokens: remaining, timeoutMs: timeLeft },
  }, endpoint.apiKey, isCurrent, progress => onProgress?.({
    ...progress, tokensIn: reply.tokensIn + progress.tokensIn, tokensOut: reply.tokensOut + progress.tokensOut,
  }));
  next.tokensIn += reply.tokensIn;
  next.tokensOut += reply.tokensOut;
  next.transcript = `Primary provider ${primary.provider}: ${reply.tokensIn}/${reply.tokensOut} tokens. Fallback: ${provider}. Reason: ${reply.error}.\n${next.transcript}`;
  return { run: { reply: next, provider, model }, root };
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
  const maxAgeMs = 2 * (agentLimits().timeoutMs + CHILD_GRACE_MS + DOWNLOAD_TIMEOUT_MS);
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const dir = join(base, name);
    try {
      if (Date.now() - (await stat(dir)).mtimeMs < maxAgeMs) continue;
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      console.log(`[agent] removed a stale repository copy: ${dir}`);
    } catch (error) {
      console.warn(`[agent] failed to remove ${dir}:`, error);
    }
  }
}
