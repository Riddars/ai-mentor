import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchProject, verifyProjectCandidates, type AuditPipelineOptions, type AuditCandidate } from "@/lib/curator/project-audit-pipeline";
import { repositoryInventory } from "@/lib/curator/repository-inventory";
import { memoryPipelineStore } from "@/lib/curator/pipeline-store";
import { ExecutionBudget, ContextWindowError } from "@/lib/llm/execution";
import { assertUnitCoverage, sourceUnit } from "@/lib/curator/context-parts";
import type { ChatMessage, ChatResult } from "@/lib/llm/chat";
import type { AuditHistory } from "@/lib/curator/project-audit-store";
import { presentProjectAudit, projectAuditReport, projectAuditSummary } from "@/lib/curator/project-audit-report";
import { outcomeLabel } from "@/lib/format";

const directory = await mkdtemp(join(tmpdir(), "project-audit-test-"));
const budget = () => new ExecutionBudget({ maxTokens: 950000, deadlineAt: Date.now() + 60000 });
const answer = (value: unknown): ChatResult => ({ content: JSON.stringify(value), usage: { input: 10, output: 10 }, model: "fixture", provider: "fixture" });
const legacy = { trigger: "project_audit", outcome: "partial", headSha: "a".repeat(40),
  summary: "Поиск с ограничениями: новых подтверждённых замечаний 4, непроверенных вопросов 6.",
  comment: "Непроверенный вопрос: ignored hypothesis", rawResponse: JSON.stringify({ result: { accepted: [{ title: "Confirmed issue" }] } }) };
const presented = presentProjectAudit(legacy);
assert.equal(presented.outcome, "ok"); assert.equal(presented.summary, projectAuditSummary(4));
assert.ok(presented.comment.includes("Confirmed issue")); assert.ok(!presented.comment.includes("hypothesis"));
assert.equal(legacy.outcome, "partial", "historical storage is not rewritten");
assert.equal(presentProjectAudit({ ...legacy, trigger: "overview" }).outcome, "partial");
assert.equal(presentProjectAudit({ ...legacy, outcome: "error", summary: "Поиск не завершён: deadline" }).outcome, "error");
assert.equal(presentProjectAudit({ ...legacy, summary: "Материалы не были обработаны" }).outcome, "partial");
assert.equal(outcomeLabel("error", "project_audit"), "поиск не завершён");
assert.ok(projectAuditReport(projectAuditSummary(0), legacy.headSha, []).includes("замечаний 0"));
try {
  const root = join(directory, "repo"), scratch = join(directory, "views");
  await mkdir(root); await mkdir(scratch);
  await writeFile(join(root, "code.ts"), "export function isValid(expiry: number) {\n  return expiry < Date.now();\n}\n");
  await writeFile(join(root, "data.csv"), "RAW_CSV_MUST_NOT_LEAK");
  await writeFile(join(root, "test.ipynb"), JSON.stringify({ cells: [{ cell_type: "code", source: ["notebook_code = 1\n"], outputs: [{ text: "NOTEBOOK_OUTPUT_MUST_NOT_LEAK" }] }] }));
  await writeFile(join(root, "RESEARCH.md"), "Tokens must expire after their deadline.");
  const inventory = await repositoryInventory(root, "a".repeat(40), scratch);
  const source = inventory.sources.find(s => s.path === "code.ts")!;
  const finding: AuditCandidate = { priorId: null, status: "open", title: "Reversed expiry", area: "code", severity: "important", description: "Reversed comparison",
    evidence: "return expiry < Date.now()", impact: "Expired tokens accepted", recommendation: "Reverse comparison", verify: "Test expiration",
    locations: [{ kind: "file", target: "code.ts", detail: "2" }], sourceIds: [source.id] };
  let calls = 0;
  const options: AuditPipelineOptions = { sources: inventory.sources, excluded: inventory.excluded,
    input: { sha: "a".repeat(40), map: "Project map", notes: "Supervisor requirements", requirements: { "RESEARCH.md": "deadline requirement" }, history: [] },
    budget: budget(), store: memoryPipelineStore(), limits: { contextTokens: 128000, outputTokens: 15000 },
    ask: async messages => {
      calls++;
      const raw = JSON.stringify(messages);
      assert.ok(!raw.includes("RAW_CSV_MUST_NOT_LEAK")); assert.ok(!raw.includes("NOTEBOOK_OUTPUT_MUST_NOT_LEAK"));
      assert.ok(raw.includes("notebook_code")); assert.ok(raw.includes("Supervisor requirements"));
      assert.ok(raw.includes("deadline requirement"));
      return answer({ summary: "Existing defect", findings: [{ ...finding, source_ids: finding.sourceIds }], unresolved: [] });
    } };
  const result = await searchProject(options);
  assert.equal(calls, 1); assert.equal(result.findings.length, 1);
  await searchProject({ ...options, budget: new ExecutionBudget({ maxTokens: 1, deadlineAt: Date.now() + 60000 }), ask: async () => { throw new Error("search repeated"); } });
  const verified = await verifyProjectCandidates({ ...options, ask: async messages => {
    const raw = JSON.stringify(messages); assert.ok(raw.includes("expiry"));
    return answer({ status: "confirmed", reason: "Source proves the reversed condition" });
  } }, result.findings, []);
  assert.equal(verified.accepted.length, 1);
  const mixedReply = { summary: "Two candidates", findings: [
    { ...finding, source_ids: finding.sourceIds },
    { ...finding, title: "Invalid category", area: "documentation", source_ids: finding.sourceIds },
  ], unresolved: [] };
  let mixedRepairs = 0;
  const salvaged = await searchProject({ ...options, store: memoryPipelineStore(), ask: async (messages, call) => {
    if (call?.phase === "json_repair") {
      mixedRepairs++;
      assert.match(messages[0].content, /findings\[1\]\.area: allowed values are code, data, methodology/);
    }
    return answer(mixedReply);
  } });
  assert.equal(mixedRepairs, 2);
  assert.deepEqual(salvaged.findings.map(candidate => candidate.title), [finding.title]);
  assert.equal((await verifyProjectCandidates({ ...options, store: memoryPipelineStore(),
    ask: async () => answer({ status: "confirmed", reason: "Source confirms the remaining candidate" }) }, salvaged.findings, [])).accepted.length, 1);
  const restricted = { ...finding, locations: [{ kind: "data" as const, target: "data.csv", detail: "1" }] };
  const missing = await verifyProjectCandidates({ ...options, ask: async () => { throw new Error("metadata is not evidence"); } }, [restricted], []);
  assert.equal(missing.accepted.length, 0); assert.equal(missing.unresolved.length, 1);
  const history: AuditHistory[] = [{ id: 1, status: "dismissed", title: "Different title, same reason", description: "comparison", evidence: "expiry", locations: "[]",
    impact: null, recommendation: null, verify: null, history: '[{"actor":"supervisor","reason":"intentional"}]', updatedAt: "now" }];
  const check = async (status: string, currentHistory = history) => verifyProjectCandidates({ ...options, store: memoryPipelineStore(), ask: async messages =>
    answer(messages[0].content.includes("полной историей") ? { status, matchingIds: [1], reason: "same cause/location" } : { status: "confirmed", reason: "source" }) }, [finding], currentHistory);
  assert.equal((await check("duplicate")).accepted.length, 0);
  assert.equal((await check("unresolved")).unresolved.length, 1);
  assert.equal((await check("regression")).accepted.length, 0, "human dismissal cannot be reopened through regression");
  assert.ok((await check("regression", [{ ...history[0], status: "closed" }])).accepted[0].reason?.includes("#1"));
  assert.equal((await verifyProjectCandidates({ ...options, store: memoryPipelineStore(), ask: async () => answer({ status: "refuted", reason: "Not a bug" }) }, [finding], [])).accepted.length, 0);
  console.log("ok audit: one no-tools search, source verification, CSV/notebook policy, requirements/history, no search rebilling, human dismissal and regressions");

  const bigSources = Array.from({ length: 8 }, (_, i) => {
    const bytes = Buffer.from((`file ${i}\n` + "x".repeat(10000)));
    return { ...source, id: "source-" + i, path: `file-${i}.ts`, bytes: bytes.length, read: async (from: number, to: number) => bytes.subarray(from, to) };
  });
  let successes = 0, interrupt = true, rejectedWindow = false;
  const seen = new Set<string>();
  const large = { ...options, sources: bigSources, store: memoryPipelineStore(), budget: budget(), limits: { contextTokens: 16000, outputTokens: 1500 },
    ask: async (messages: ChatMessage[]) => {
      if (!rejectedWindow) { rejectedWindow = true; throw new ContextWindowError(12000); }
      if (interrupt && successes === 1) throw new Error("interrupted");
      const key = JSON.stringify(messages); assert.ok(!seen.has(key), "completed source search repeated"); seen.add(key); successes++;
      return answer({ summary: "part", findings: [], unresolved: [] });
    } };
  await assert.rejects(searchProject(large), /interrupted/);
  interrupt = false;
  const resumed = await searchProject(large);
  assert.ok(successes > 1);
  const covered = resumed.coverage as Array<{ source: string; from: number; to: number }>;
  assertUnitCoverage(bigSources.map(s => sourceUnit(s)), covered.map(c => sourceUnit(bigSources.find(s => s.id === c.source)!, c.from, c.to)));
  let repairs = 0;
  const repaired = await searchProject({ ...options, store: memoryPipelineStore(), ask: async () => {
    repairs++; return repairs === 1 ? { ...answer({}), content: "bad JSON" } : answer({ summary: "fixed", findings: [], unresolved: [] });
  } });
  assert.equal(repairs, 2); assert.equal(repaired.summary, "fixed");
  const brokenStore = memoryPipelineStore(); let badCalls = 0;
  await assert.rejects(searchProject({ ...options, store: brokenStore, configuration: "broken-model", ask: async () => {
    badCalls++; return { ...answer({}), content: "invalid" };
  } }), /invalid_format/);
  assert.equal(badCalls, 3);
  await assert.rejects(searchProject({ ...options, store: brokenStore, configuration: "broken-model", ask: async () => { throw new Error("unchanged exhausted repairs must not call"); } }), /invalid_format/);
  const recovered = await searchProject({ ...options, store: brokenStore, configuration: "working-model", ask: async () => answer({ summary: "recovered", findings: [], unresolved: [] }) });
  assert.equal(recovered.summary, "recovered");
  const manyHistory = Array.from({ length: 40 }, (_, i) => ({ ...history[0], id: i + 1, evidence: "e".repeat(3000) }));
  let compared = 0;
  const completeHistory = await verifyProjectCandidates({ ...options, limits: { contextTokens: 16000, outputTokens: 1500 }, store: memoryPipelineStore(),
    ask: async messages => { if (messages[0].content.includes("полной историей")) { compared++; return answer({ status: "new", matchingIds: [], reason: "different cause" }); }
      return answer({ status: "confirmed", reason: "source" }); } }, [finding], manyHistory);
  assert.ok(compared > 1); assert.equal(completeHistory.accepted.length, 1);
  console.log("ok audit: multipart exact coverage, smaller-window replan, interrupted search resume, format repair and complete batched history");
} finally { await rm(directory, { recursive: true, force: true }); }
