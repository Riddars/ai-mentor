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
    maxToolCalls: numberEnv("AGENT_MAX_TOOL_CALLS", 30),
    maxTokens: numberEnv("AGENT_TOKENS_PER_RUN", 400_000),
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
  let received = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      done(received > MAX_ARCHIVE_BYTES ? new Error(`Repository archive is larger than ${MAX_ARCHIVE_BYTES} bytes`) : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), limit, createWriteStream(dest));
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
export function runAgentProcess(request: AgentRequest, apiKey: string, isCurrent?: () => boolean): Promise<AgentReply> {
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
  input: { systemPrompt: string; userPrompt: string; changed: string[]; limits?: AgentLimitsSpec },
  consume: (run: AgentRun, root: string) => Promise<T>,
  isCurrent?: () => boolean,
): Promise<T> {
  const { provider, baseUrl, model, apiKey } = agentModel();
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    const tarPath = join(dir, "repo.tar.gz");
    const root = join(dir, "repo");
    await downloadTarball(target, tarPath);
    const reply = await runAgentProcess(
      {
        type: "run",
        tarPath,
        root,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        changed: input.changed,
        model: { baseUrl, model },
        limits: input.limits ?? agentLimits(),
      },
      apiKey,
      isCurrent,
    );
    return await consume({ reply, provider, model }, root);
  } finally {
    // A failed removal must not replace the result or the original error.
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch((error) =>
      console.warn(`[agent] failed to remove ${dir}:`, error),
    );
  }
}

/**
 * A short agent run over a copy already on disk (made by `withAgentRun`), e.g. to check the
 * findings of the run that made it. A failed run is thrown with the tokens it spent.
 */
export async function runAgentOnCopy(
  root: string,
  input: { systemPrompt: string; userPrompt: string; limits: AgentLimitsSpec },
): Promise<AgentRun> {
  const { provider, baseUrl, model, apiKey } = agentModel();
  const reply = await runAgentProcess(
    {
      type: "run",
      root,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      changed: [],
      model: { baseUrl, model },
      limits: input.limits,
    },
    apiKey,
  );
  if (reply.error) {
    throw new AgentProcessError(reply.error, { input: reply.tokensIn, output: reply.tokensOut });
  }
  return { reply, provider, model };
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
  // Twice the longest run, which leaves room for the verification run after it.
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
