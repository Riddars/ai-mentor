/** Paid acceptance: local Git fixture + real configured models; never writes GitHub. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { safeGit, openReviewRepository } from "@/lib/curator/pr-full-diff";
import { configuredPrTargets } from "@/lib/agent/pr-targets.mjs";
import { runPrPipeline } from "@/lib/curator/pr-pipeline";
import { ExecutionBudget } from "@/lib/llm/execution";

const root = resolve("data/local-pr-reviews"); await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, "run-"));
const gitDirectory = join(directory, "repository"); await mkdir(gitDirectory);
const git = async (args: string[], input?: string) => (await safeGit(gitDirectory, args, { input })).toString("utf8").trim();
await git(["init", "--bare", "--template=", gitDirectory]);
const good = 'export interface Token { expiresAtMs: number }\n\n/** A token is valid strictly before its expiry, all times are epoch milliseconds. */\nexport function isValidToken(token: Token, nowMs: number): boolean {\n  return nowMs < token.expiresAtMs;\n}\n';
const readme = await git(["hash-object", "-w", "--stdin"], "# Session validation\nReject expired tokens. Token.expiresAtMs and nowMs are epoch milliseconds.\n");
const commit = async (text: string, message: string, parent?: string) => {
  const file = await git(["hash-object", "-w", "--stdin"], text);
  const tree = await git(["mktree"], `100644 blob ${readme}\tREADME.md\n100644 blob ${file}\tauth.ts\n`);
  return git(["-c", "user.name=Local acceptance", "-c", "user.email=acceptance@example.invalid", "commit-tree", tree, ...(parent ? ["-p", parent] : [])], message);
};
const base = await commit(good, "baseline");
const broken = await commit(good.replace("nowMs < token.expiresAtMs", "nowMs > token.expiresAtMs"), "introduce expired-token regression", base);
const clean = await commit(good.replace("all times are epoch milliseconds", "both arguments use epoch milliseconds"), "clarify comment with correct validation", base);
const targets = configuredPrTargets();
const budget = new ExecutionBudget({ maxTokens: 60000, deadlineAt: Date.now() + 10 * 60000 });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "api.github.com") throw new Error("GitHub network is forbidden in local PR acceptance");
  return originalFetch(input, init);
};
try {
  for (const [label, head] of [["bug", broken], ["clean", clean]] as const) {
    const repository = await openReviewRepository(gitDirectory, base, head);
    const events: Record<string, unknown>[] = [];
    const before = budget.spent.input + budget.spent.output;
    const result = await runPrPipeline({ repository, context: "TypeScript library for validating session token expiration. Review only concrete defects introduced by the PR. All timestamps are milliseconds.",
      ...targets, budget, onEvent: event => { events.push(event); if (["model_call_started", "pr_part_failed"].includes(String(event.type))) console.log(JSON.stringify({ label, ...event })); } });
    await writeFile(join(directory, label + ".json"), JSON.stringify({ ...result, changed: [...result.changed], events, calls: budget.calls }, null, 2));
    await writeFile(join(directory, label + ".md"), result.result.summary + "\n\n" + result.result.findings.map(f => `## ${f.title}\n${f.description}\n${f.evidence}\n${f.recommendation}`).join("\n\n"));
    assert.equal(result.quality, "complete", `${label}: review must complete without intervention`);
    if (label === "bug") assert.ok(result.result.findings.some(f => f.locations?.some(l => l.target === "auth.ts")), "known expiration bug must be reported");
    else assert.equal(result.result.findings.length, 0, "comment-only PR must not invent defects");
    console.log(JSON.stringify({ label, directory, quality: result.quality, findings: result.result.findings.length,
      tokens: budget.spent.input + budget.spent.output - before, unknownTokens: budget.unknownTokens }));
  }
  await writeFile(join(directory, "budget.json"), JSON.stringify(budget.snapshot(), null, 2));
  console.log("PASS real-model PR acceptance: " + directory);
} finally { globalThis.fetch = originalFetch; }
