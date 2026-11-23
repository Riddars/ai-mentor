import { spawn } from "node:child_process";
import { mkdtemp, rm, opendir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInstallationToken } from "@/lib/github/auth";
import { githubRequest } from "@/lib/github/api";
import type { ReviewParams } from "./review";
import { hashText, sourceUnit, splitTextUnit, type ContextSource, type SourceUnit } from "./context-parts";
import { snapshotExclusion } from "./snapshot-policy";
import { ExecutionBudget, ExecutionBudgetError } from "@/lib/llm/execution";

export interface DiffChange { oldMode: string; newMode: string; oldBlob: string; newBlob: string; status: string; oldPath: string; newPath: string }
interface DiffLine { from: number; to: number; oldLine: number | null; newLine: number | null; operation: string }
export interface DiffSource extends ContextSource { change: DiffChange; lines: DiffLine[]; hunks: number[]; omittedReason?: string }
export interface FullFile { path: string; revision: string; blob: string; mode: string; bytes: Buffer }
export interface ReviewRepository {
  base: string; head: string; mergeBase: string;
  changes: DiffChange[]; sources: DiffSource[];
  readFile(path: string, revision: "head" | "base"): Promise<FullFile | null>;
}
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_REPOSITORY_BYTES = 512 * 1024 * 1024;
async function checkGitDisk(directory: string, maximum: number) {
  let total = 0;
  const pending = [directory];
  while (pending.length) {
    let entries;
    try { entries = await opendir(pending.pop()!); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for await (const entry of entries) {
      const path = join(entries.path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("incomplete_snapshot: unexpected Git disk symlink");
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try { total += (await stat(path)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (total > maximum) throw new Error("incomplete_snapshot: Git disk loading limit exceeded");
      }
    }
  }
}

export async function safeGit(directory: string, args: string[], options: { env?: Record<string, string | undefined>; timeoutMs?: number; maxBytes?: number; input?: string | Buffer;
  maxRepositoryBytes?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
  if (options.signal?.aborted) throw new ExecutionBudgetError("cancelled");
  const diskLimit = options.maxRepositoryBytes ?? MAX_REPOSITORY_BYTES;
  await checkGitDisk(directory, diskLimit);
  return new Promise((resolve, reject) => {
    const inherited = { ...process.env };
    for (const key of Object.keys(inherited)) if (key.toUpperCase().startsWith("GIT_")) delete inherited[key];
    const child = spawn("git", ["-c", "core.hooksPath=", "-c", "core.attributesFile=", "-c", "core.quotePath=true",
      "-c", "diff.external=", "-c", "credential.helper=", "-c", "fetch.unpackLimit=1", "--git-dir=" + directory, ...args], {
      windowsHide: true, detached: process.platform !== "win32", shell: false, env: { ...inherited,
        GIT_CONFIG_COUNT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0", ...options.env, NODE_ENV: process.env.NODE_ENV ?? "development" },
    });
    const chunks: Buffer[] = [];
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    let bytes = 0, failure: Error | undefined;
    let stopped = false, closed = false;
    const stop = (error: Error) => {
      if (closed) return;
      failure ??= error;
      if (stopped || !child.pid) return;
      stopped = true;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const abort = () => stop(new ExecutionBudgetError(options.signal?.reason?.name === "TimeoutError" ? "deadline" : "cancelled"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => stop(new ExecutionBudgetError("deadline")), Math.max(1, options.timeoutMs ?? 120000));
    let checking = false;
    const watchdog = setInterval(() => {
      if (checking || stopped) return;
      checking = true;
      void checkGitDisk(directory, diskLimit).catch(stop).finally(() => { checking = false; });
    }, 250);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? MAX_BYTES)) stop(new Error("incomplete_snapshot: git output exceeds safe loading limit"));
      else chunks.push(chunk);
    });
    // Do not echo stderr: transport errors may contain authorization details.
    child.stderr.resume();
    child.on("error", error => { failure = error; });
    child.on("close", code => {
      closed = true;
      clearTimeout(timer); clearInterval(watchdog); options.signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(failure ?? new Error(`git_failed: ${args[0]} (exit ${code})`));
      else void checkGitDisk(directory, diskLimit).then(() => resolve(Buffer.concat(chunks)), reject);
    });
  });
}
export function parseRawChanges(raw: Buffer): DiffChange[] {
  const tokens = new TextDecoder("utf-8", { fatal: true }).decode(raw).split("\0");
  const result: DiffChange[] = [];
  for (let i = 0; i < tokens.length && tokens[i];) {
    const header = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)$/.exec(tokens[i++]);
    if (!header || !tokens[i]) throw new Error("incomplete_snapshot: invalid raw git diff");
    const oldPath = tokens[i++];
    const status = header[5];
    const newPath = /^[RC]/.test(status) ? tokens[i++] : oldPath;
    if (!newPath) throw new Error("incomplete_snapshot: missing rename target");
    result.push({ oldMode: header[1], newMode: header[2], oldBlob: header[3], newBlob: header[4], status, oldPath, newPath });
  }
  return result;
}
function diffLines(text: string): { lines: DiffLine[]; hunks: number[] } {
  const lines: DiffLine[] = [], hunks: number[] = [];
  let offset = 0, old = 0, current = 0, inside = false;
  for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (raw.startsWith("diff --git ")) inside = false;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { old = Number(hunk[1]); current = Number(hunk[2]); inside = true; hunks.push(offset); }
    const operation = inside && !hunk ? raw[0] : "metadata";
    const oldLine = inside && ["-", " "].includes(operation) ? old++ : null;
    const newLine = inside && ["+", " "].includes(operation) ? current++ : null;
    const end = offset + Buffer.byteLength(raw);
    lines.push({ from: offset, to: end, oldLine, newLine, operation }); offset = end;
  }
  return { lines, hunks };
}
export function diffSources(rawPatch: Buffer, changes: DiffChange[], revision: string): DiffSource[] {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawPatch);
  const starts = [...text.matchAll(/^diff --git /gm)].map(match => match.index);
  if ((starts.length && starts[0] !== 0) || starts.length < changes.length) throw new Error("incomplete_snapshot: raw/patch file coverage mismatch");
  let block = 0;
  const result = changes.map(change => {
    const start = starts[block];
    if (start === undefined) throw new Error("incomplete_snapshot: missing patch block");
    let count = 1;
    const first = text.slice(start, starts[block + 1] ?? text.length);
    const second = text.slice(starts[block + 1] ?? text.length, starts[block + 2] ?? text.length);
    // Git emits a type change as a deletion and addition sharing one raw T record.
    if (change.status === "T" && /^deleted file mode /m.test(first) && /^new file mode /m.test(second) && first.split("\n")[0] === second.split("\n")[0]) count = 2;
    const original = text.slice(start, starts[block + count] ?? text.length);
    block += count;
    // Check both names: renaming data to a source extension must not expose its old content.
    const omittedReason = snapshotExclusion(change.oldPath) ?? snapshotExclusion(change.newPath) ?? undefined;
    const patch = omittedReason ? JSON.stringify({ change, omittedReason }) : original;
    const bytes = Buffer.from(patch);
    const viewHash = hashText(bytes);
    const id = hashText(JSON.stringify([revision, change, viewHash]));
    return { id, path: change.newPath, revision, kind: "diff", bytes: bytes.length, originalHash: hashText(original), viewHash,
      transformation: omittedReason ? "excluded-diff-metadata-v2" : "git-unified-diff-v1", change, omittedReason, ...diffLines(patch), read: async (from: number, to: number) => bytes.subarray(from, to) };
  });
  if (block !== starts.length) throw new Error("incomplete_snapshot: unassigned patch blocks");
  return result;
}
export async function splitDiffUnit(unit: SourceUnit) {
  const source = unit.source as DiffSource;
  const hunks = source.hunks.filter(position => position > unit.from && position < unit.to);
  if (hunks.length) {
    const middle = (unit.from + unit.to) / 2;
    const cut = hunks.reduce((best, p) => Math.abs(p - middle) < Math.abs(best - middle) ? p : best);
    return [sourceUnit(source, unit.from, cut), sourceUnit(source, cut, unit.to)];
  }
  return splitTextUnit(unit);
}
export function diffRangeMetadata(unit: SourceUnit) {
  const source = unit.source as DiffSource;
  let low = 0, high = source.lines.length;
  while (low < high) { const middle = (low + high) >>> 1; if (source.lines[middle].to <= unit.from) low = middle + 1; else high = middle; }
  const line = source.lines[low];
  return { change: source.change, fromByte: unit.from, toByte: unit.to,
    firstLine: line ? { old: line.oldLine, new: line.newLine, operation: line.operation, byteOffsetWithinLine: unit.from - line.from } : null,
    fragment: unit.from !== 0 || unit.to !== source.bytes };
}
export async function openReviewRepository(directory: string, base: string, head: string, env?: Record<string, string | undefined>, pinnedMergeBase?: string, budget?: ExecutionBudget): Promise<ReviewRepository> {
  const git = (args: string[], options: { maxBytes?: number } = {}) => {
    if (budget && budget.remainingMs <= 0) throw new ExecutionBudgetError("deadline");
    return safeGit(directory, args, { ...options, env, timeoutMs: Math.min(120000, budget?.remainingMs ?? 120000),
      signal: budget ? AbortSignal.timeout(Math.max(1, budget.remainingMs)) : undefined });
  };
  if (!SHA.test(base) || !SHA.test(head)) throw new Error("Invalid revision");
  const mergeBase = pinnedMergeBase ?? (await git(["merge-base", base, head])).toString("utf8").trim();
  if (!SHA.test(mergeBase)) throw new Error("incomplete_snapshot: unavailable merge base");
  const flags = ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--no-abbrev"];
  const raw = await git(["diff", ...flags, "--raw", "-z", mergeBase, head, "--"]);
  const patch = await git(["diff", ...flags, "--patch", "--unified=3", mergeBase, head, "--"]);
  const changes = parseRawChanges(raw);
  const sources = diffSources(patch, changes, `${mergeBase}..${head}`);
  return { base, head, mergeBase, changes, sources,
    async readFile(path, revision) {
      if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some(p => p === ".." || p === "." || !p)) return null;
      const sha = revision === "base" ? mergeBase : head;
      const tree = await git(["ls-tree", "-z", sha, "--", ":(literal)" + path]);
      const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t/.exec(tree.toString("utf8"));
      if (!match || match[2] !== "blob") return null;
      const mode = match[1], blob = match[3];
      if (!/^100(?:644|755)$/.test(mode)) return null;
      const size = Number((await git(["cat-file", "-s", blob])).toString("utf8"));
      if (size > 50 * 1024 * 1024) throw new Error("file_too_large: safe blob loading limit");
      return { path, revision: sha, blob, mode, bytes: await git(["cat-file", "blob", blob], { maxBytes: 50 * 1024 * 1024 }) };
    } };
}
/** Immutable Git objects, no checkout, no repository code or attribute filters executed. */
export async function withReviewRepository<T>(params: ReviewParams, consume: (repository: ReviewRepository) => Promise<T>, budget?: ExecutionBudget): Promise<T> {
  if (budget && budget.remainingMs <= 0) throw new ExecutionBudgetError("deadline");
  if (!/^[A-Za-z0-9_.-]+$/.test(params.owner) || !/^[A-Za-z0-9_.-]+$/.test(params.repo) || !SHA.test(params.headSha)) throw new Error("Invalid repository target");
  const token = await getInstallationToken(params.installationId);
  const signal = budget ? AbortSignal.timeout(Math.max(1, budget.remainingMs)) : undefined;
  const pr = await githubRequest<{ base: { sha: string }; head: { sha: string } }>(`/repos/${params.owner}/${params.repo}/pulls/${params.prNumber}`, { token, signal });
  if (pr.head.sha !== params.headSha || !SHA.test(pr.base.sha)) throw new Error("superseded: PR revisions changed");
  // Only consume merge_base_commit from compare, never its capped files/patch list.
  // https://docs.github.com/en/rest/commits/commits#compare-two-commits
  const comparison = await githubRequest<{ merge_base_commit: { sha: string } }>(`/repos/${params.owner}/${params.repo}/compare/${pr.base.sha}...${params.headSha}?per_page=1`, { token, signal });
  const mergeBase = comparison.merge_base_commit?.sha;
  if (!mergeBase || !SHA.test(mergeBase)) throw new Error("incomplete_snapshot: unavailable merge base");
  const directory = await mkdtemp(join(tmpdir(), "curator-pr-git-"));
  try {
    const command = (args: string[], env?: Record<string, string | undefined>) => safeGit(directory, args, { env,
      timeoutMs: Math.min(180000, budget?.remainingMs ?? 180000), signal: budget ? AbortSignal.timeout(Math.max(1, budget.remainingMs)) : undefined });
    await command(["init", "--bare", "--template=", directory]);
    const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic " + Buffer.from("x-access-token:" + token).toString("base64") };
    await command(["remote", "add", "origin", `https://github.com/${params.owner}/${params.repo}.git`]);
    await command(["config", "remote.origin.promisor", "true"]);
    await command(["config", "remote.origin.partialclonefilter", "blob:none"]);
    await command(["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--filter=blob:none", "origin",
      pr.base.sha, params.headSha, mergeBase], env);
    return await consume(await openReviewRepository(directory, pr.base.sha, params.headSha, env, mergeBase, budget));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
