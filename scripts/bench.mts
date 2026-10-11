/**
 * Run the review agent over the curator-bench cases and score the answers.
 *
 *   npx tsx --env-file=.env.local scripts/bench.mts [--cases S01,D] [--dry] [--no-verify] [--out file.json] [--log dir]
 *
 * BENCH_DIR points at a checkout of RiddarsCorp/curator-bench (default: ../curator-bench).
 * --dry builds every case and prompt without calling the model (free).
 * --log writes the agent's whole conversation of each case to <dir>/<case>.md.
 * Each case is built in a temporary git repository: the project, then `before/`, a commit,
 * then `files/`; the staged diff is the PR. The prompt is built by the service code.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_KEY_ENV, openAICompatibleModel, runAgent } from "@/lib/agent/agent.mjs";
import { AGENT_RULES, repositorySection } from "@/lib/agent/prompt";
import { transcript } from "@/lib/agent/transcript.mjs";
import { agentLimits } from "@/lib/agent/run";
import { listRepoFiles, relatedFiles, repoMap } from "@/lib/agent/workspace";
import { buildReviewPrompt, formatChanges, selectPriorFindings, type PrFile } from "@/lib/curator/context";
import { SYSTEM_PROMPT, parseModelJson } from "@/lib/curator/review";
import type { PriorFinding, ReconciledFinding, StudentResponse } from "@/lib/curator/store";
import { verifyFindings } from "@/lib/curator/verify";
import { chat, openAICompatibleEndpoint, type ChatMessage } from "@/lib/llm/chat";

interface ExpectedFinding {
  area: string[];
  severity: string[];
  files?: string[];
  keywords: string[];
}

interface CaseSpec {
  project: string;
  kind: "error" | "clean" | "attack" | "reconcile";
  error_type: string;
  outside_diff: boolean;
  pr_number?: number;
  notes: string;
  open_findings?: PriorFinding[];
  student_replies?: StudentResponse[];
  expected: ExpectedFinding[];
  expected_decisions?: Array<{ prior_id: number; status: string[] }>;
  max_extra_findings: number;
}

interface BuiltCase {
  id: string;
  spec: CaseSpec;
  root: string;
  files: PrFile[];
  prompt: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** The staged diff as GitHub's PR files list: status, counts and the hunks of each file. */
function stagedFiles(root: string): PrFile[] {
  const statuses = new Map<string, string>();
  for (const line of git(root, ["diff", "--cached", "--name-status"]).trim().split("\n")) {
    const [code, path] = line.split("\t");
    statuses.set(path, code === "A" ? "added" : code === "D" ? "removed" : "modified");
  }
  return git(root, ["diff", "--cached", "--numstat"])
    .trim()
    .split("\n")
    .map((line) => {
      const [added, deleted, path] = line.split("\t");
      const diff = git(root, ["diff", "--cached", "--", path]);
      const hunks = diff.indexOf("\n@@");
      return {
        filename: path,
        status: statuses.get(path) ?? "modified",
        additions: Number(added) || 0,
        deletions: Number(deleted) || 0,
        patch: added === "-" || hunks === -1 ? undefined : diff.slice(hunks + 1).trimEnd(),
      };
    });
}

async function buildCase(benchDir: string, id: string): Promise<BuiltCase> {
  const caseDir = join(benchDir, "cases", id);
  const spec = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")) as CaseSpec;
  const root = mkdtempSync(join(tmpdir(), `bench-${id}-`));
  cpSync(join(benchDir, "projects", spec.project), root, { recursive: true });
  if (existsSync(join(caseDir, "before"))) cpSync(join(caseDir, "before"), root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=bench", "-c", "user.email=bench@local", "commit", "-qm", "base"]);
  cpSync(join(caseDir, "files"), root, { recursive: true });
  git(root, ["add", "-A"]);
  const files = stagedFiles(root);
  rmSync(join(root, ".git"), { recursive: true, force: true });

  const prNumber = spec.pr_number ?? 10;
  const changes = await formatChanges(files, files.length, async (path) => readOrNull(join(root, path)));
  const prompt = buildReviewPrompt({
    prNumber,
    prior: selectPriorFindings(spec.open_findings ?? [], prNumber),
    research: readOrNull(join(root, "RESEARCH.md")),
    plan: readOrNull(join(root, "PLAN.md")),
    prBody: readFileSync(join(caseDir, "pr.md"), "utf8"),
    replies: spec.student_replies ?? [],
    changes: changes.text,
  });
  return { id, spec, root, files, prompt };
}

function matches(expected: ExpectedFinding, finding: ReconciledFinding): boolean {
  const text = `${finding.title} ${finding.description ?? ""}`;
  return (
    expected.area.includes(finding.area ?? "") &&
    expected.severity.includes(finding.severity ?? "") &&
    expected.keywords.some((k) => new RegExp(k, "i").test(text))
  );
}

interface Score {
  pass: boolean;
  found: number;
  extras: number;
  decisionsOk: boolean;
}

function score(spec: CaseSpec, findings: ReconciledFinding[]): Score {
  const fresh = findings.filter((f) => f.priorId === null);
  const used = new Set<number>();
  let found = 0;
  for (const expected of spec.expected) {
    const index = fresh.findIndex((f, i) => !used.has(i) && matches(expected, f));
    if (index !== -1) {
      used.add(index);
      found += 1;
    }
  }
  const extras = fresh.length - used.size;
  const decisionsOk = (spec.expected_decisions ?? []).every(({ prior_id, status }) => {
    // A prior finding the answer does not mention stays as it was, i.e. open.
    const decision = findings.find((f) => f.priorId === prior_id)?.status ?? "open";
    return status.includes(decision);
  });
  return { pass: found === spec.expected.length && extras <= spec.max_extra_findings && decisionsOk, found, extras, decisionsOk };
}

async function fetchPricing(baseUrl: string, apiKey: string, model: string): Promise<{ prompt: number; completion: number }> {
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const body = (await res.json()) as { data?: Array<{ id: string; pricing?: Record<string, string> }> };
    const pricing = body.data?.find((m) => m.id === model)?.pricing ?? {};
    return { prompt: Number(pricing.prompt) || 0, completion: Number(pricing.completion) || 0 };
  } catch {
    return { prompt: 0, completion: 0 };
  }
}

async function main() {
  const benchDir = resolve(process.env.BENCH_DIR ?? join(process.cwd(), "..", "curator-bench"));
  const filters = arg("cases")?.split(",") ?? [];
  const dry = process.argv.includes("--dry");
  const verify = !process.argv.includes("--no-verify");
  const outFile = arg("out");
  const logDir = arg("log");
  if (logDir) mkdirSync(logDir, { recursive: true });
  const ids = readdirSync(join(benchDir, "cases"))
    .filter((id) => filters.length === 0 || filters.some((f) => id.startsWith(f)))
    .sort();

  let runner: { models: ReturnType<typeof openAICompatibleModel>["models"]; model: ReturnType<typeof openAICompatibleModel>["model"] } | null = null;
  let pricing = { prompt: 0, completion: 0 };
  if (!dry) {
    const provider = process.env.LLM_PROVIDER ?? "";
    const endpoint = openAICompatibleEndpoint(provider);
    const modelId = process.env.AGENT_MODEL ?? process.env.LLM_MODEL;
    if (!endpoint?.apiKey || !modelId) throw new Error("LLM_PROVIDER with a key and AGENT_MODEL or LLM_MODEL are required");
    process.env[AGENT_KEY_ENV] = endpoint.apiKey;
    runner = openAICompatibleModel({ baseUrl: endpoint.baseURL, model: modelId });
    pricing = await fetchPricing(endpoint.baseURL, endpoint.apiKey, modelId);
    console.log(`model: ${provider} ${modelId}; cases: ${ids.length}; verify: ${verify}`);
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const built = await buildCase(benchDir, id);
    try {
      const files = await listRepoFiles(built.root);
      const related = await relatedFiles(built.root, built.files.map((f) => f.filename), files);
      const userPrompt = `${built.prompt}\n\n${repositorySection(repoMap(files, { skipped: [], stoppedOn: null }), related)}`;
      if (!runner) {
        console.log(
          `${id}: files changed ${built.files.length}, prompt ${userPrompt.length} chars, ` +
            `repo files ${files.length}, related [${related.join(", ")}]`,
        );
        continue;
      }
      const started = Date.now();
      const result = await runAgent({
        root: built.root,
        systemPrompt: `${SYSTEM_PROMPT}\n${AGENT_RULES}`,
        userPrompt,
        models: runner.models,
        model: runner.model,
        limits: agentLimits(),
      });
      const parsed = result.error ? null : parseModelJson(result.text);
      const raw = parsed ? score(built.spec, parsed.findings) : null;
      const verifyTokens = { input: 0, output: 0 };
      const ask = async (messages: ChatMessage[]) => {
        const answer = await chat(messages);
        verifyTokens.input += answer.usage?.input ?? 0;
        verifyTokens.output += answer.usage?.output ?? 0;
        return answer;
      };
      const verified = parsed && verify ? await verifyFindings(parsed, built.root, ask) : null;
      const final = verified ? score(built.spec, verified.result.findings) : raw;
      const findings = (verified?.result ?? parsed)?.findings ?? [];
      const row = {
        id,
        kind: built.spec.kind,
        pass: final?.pass ?? false,
        found: `${final?.found ?? 0}/${built.spec.expected.length}`,
        extras: final?.extras ?? null,
        decisionsOk: final?.decisionsOk ?? null,
        passBeforeVerify: raw?.pass ?? false,
        dropped: verified?.dropped ?? [],
        error: result.error ?? (parsed ? null : "invalid JSON"),
        toolCalls: result.log.calls.length,
        viewed: [...result.log.viewed],
        tokens: `${result.tokensIn}/${result.tokensOut}`,
        verifyTokens: `${verifyTokens.input}/${verifyTokens.output}`,
        cost: Number(
          (
            (result.tokensIn + verifyTokens.input) * pricing.prompt +
            (result.tokensOut + verifyTokens.output) * pricing.completion
          ).toFixed(2),
        ),
        seconds: Math.round((Date.now() - started) / 1000),
        findings: findings.map((f) => `${f.priorId ?? "new"} ${f.status} [${f.area}/${f.severity}] ${f.title}`),
      };
      rows.push(row);
      console.log(
        `${id}: ${row.pass ? "PASS" : "FAIL"} found ${row.found} extras ${row.extras} decisions ${row.decisionsOk} ` +
          `(before verify: ${row.passBeforeVerify ? "pass" : "fail"}) tools ${row.toolCalls} ` +
          `tokens ${row.tokens} ≈${row.cost} ₽ ${row.seconds}s${row.error ? ` error: ${row.error}` : ""}`,
      );
      for (const f of row.findings) console.log(`    ${f}`);
      for (const d of row.dropped) console.log(`    dropped: ${d.title} — ${d.reason}`);
      if (logDir) {
        const notes = [
          ...(result.error ? [`Ошибка агента: ${result.error}`] : []),
          ...(verified ? [`Проверено моделью: ${verified.checked ? "да" : "нет"}`] : []),
          ...row.dropped.map((d) => `Отброшена «${d.title}»: ${d.reason}`),
          ...row.findings.map((f) => `Итог: ${f}`),
        ];
        writeFileSync(join(logDir, `${id}.md`), transcript(id, result.messages, notes));
      }
      if (outFile) writeFileSync(outFile, JSON.stringify(rows, null, 2));
    } finally {
      rmSync(built.root, { recursive: true, force: true });
    }
  }

  if (rows.length > 0) {
    const passed = rows.filter((r) => r.pass).length;
    const cost = rows.reduce((s, r) => s + (r.cost as number), 0);
    console.log(`\npassed ${passed}/${rows.length}, cost ≈${cost.toFixed(2)} ₽`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
