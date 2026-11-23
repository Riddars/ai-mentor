import assert from "node:assert/strict";
import { fauxProvider, createModels } from "@earendil-works/pi-ai";
import { diffSources, type DiffChange, type ReviewRepository } from "@/lib/curator/pr-full-diff";
import { collectPrEvidence, renderPrEvidence } from "@/lib/curator/pr-evidence";
import { verifyPrNode } from "@/lib/curator/pr-verification";
import { sourceUnit } from "@/lib/curator/context-parts";
import { memoryPipelineStore } from "@/lib/curator/pipeline-store";
import { ExecutionBudget, ExecutionBudgetError } from "@/lib/llm/execution";
import { LlmRequestError, type ChatMessage } from "@/lib/llm/chat";
import type { FindingLocation } from "@/lib/curator/finding";
import type { PrNode } from "@/lib/curator/pr-pipeline";

const base = "a".repeat(40), head = "b".repeat(40);
const change = (path: string, status = "M"): DiffChange => ({ oldMode: "100644", newMode: status === "D" ? "000000" : "100644", oldBlob: "c".repeat(40), newBlob: "d".repeat(40), status, oldPath: path, newPath: path });
const patch = "diff --git a/huge.ts b/huge.ts\n--- a/huge.ts\n+++ b/huge.ts\n" + Array.from({ length: 50 }, (_, i) =>
  `@@ -${i * 100 + 1},2 +${i * 100 + 1},2 @@\n //${"x".repeat(5000)}\n-old\n+new\n`).join("");
const changes = [change("huge.ts"), change("gone.ts", "D"), change("package.json")];
const sources = diffSources(Buffer.from(patch + "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n" +
  "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-old\n+new\n"), changes, "fixture");
const reads: Array<[string, string]> = [];
const repository: ReviewRepository = { base, mergeBase: base, head, changes, sources, readFile: async (path, revision) => {
  reads.push([path, revision]);
  return { path, revision: revision === "base" ? base : head, mode: "100644", blob: "d".repeat(40), bytes: Buffer.from(path === "huge.ts" ? "z".repeat(500000) : "old\nextra\nlast") };
} };
const budget = () => new ExecutionBudget({ maxTokens: 950000, deadlineAt: Date.now() + 60000 });
const limits = { contextTokens: 16000, outputTokens: 1000 };
const owner = { units: [sourceUnit(sources[0])], files: [] };
const location = (path: string, detail: string | null, kind: FindingLocation["kind"] = "file"): FindingLocation => ({ kind, target: path, detail });
const template = (proof: Parameters<typeof renderPrEvidence>[0]): ChatMessage[] => [{ role: "system", content: "verify" }, { role: "user", content: renderPrEvidence(proof) }];
const minimal = await collectPrEvidence(owner, [location("huge.ts", "2")], [sources[0].id], repository, limits, budget(), 0, template);
assert.equal(minimal.issues.length, 0);
assert.equal(minimal.units.length, 1);
assert.ok(minimal.units[0].to - minimal.units[0].from < sources[0].bytes / 10, "one relevant hunk, not all 50 hunks");
assert.equal(reads.length, 0, "complete visible citation does not demand an entire giant file");
const missingRange = await collectPrEvidence(owner, [location("huge.ts", "2-100")], [sources[0].id], repository, limits, budget(), 0, template);
assert.ok(missingRange.issues.some(i => i.reason === "context_limit"));
assert.deepEqual(reads.pop(), ["huge.ts", "head"], "one visible line cannot establish a 99-line citation");
const deleted = await collectPrEvidence({ units: [sourceUnit(sources[1])], files: [] }, [location("gone.ts", "1-3", "document")], [sources[1].id], repository, limits, budget(), 0, template);
assert.equal(deleted.issues.length, 0);
assert.equal(deleted.files[0].revision, "base");
assert.deepEqual(reads.pop(), ["gone.ts", "base"]);
const overflow = await collectPrEvidence(owner, [location("huge.ts", "9".repeat(400))], [sources[0].id], repository, limits, budget(), 0, template);
assert.ok(overflow.issues.some(i => i.reason === "invalid_citation"));

const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
for (const kind of ["data", "document", "other"] as const) {
  const node: PrNode = { id: "node-" + kind, units: [sourceUnit(sources[2])], files: [], denied: [], answer: {
    summary: "fixture", changes: "fixture", unresolved: [], refreshOverview: null, candidates: [{ sourceIds: [sources[2].id], rootCause: "fixture",
      finding: { priorId: null, status: "open", title: "fixture", locations: [location(kind === "other" ? "general claim" : "package.json", kind === "other" ? null : "1", kind)] } }],
  } };
  const common = { repository, context: "fixture", budget: budget(), store: memoryPipelineStore(), primary: { provider: "fixture", model: faux.getModel(), stream: models.streamSimple.bind(models), contextTokens: 16000 } };
  const checked = await verifyPrNode(node, { ...common, ask: async messages => {
    const data = JSON.parse(messages[1].content.split("\nИсходные материалы:\n")[0]) as { candidates: Array<{ id: string }> };
    return { provider: "fixture", model: "fixture", usage: { input: 1, output: 1 }, content: JSON.stringify({ verdicts: data.candidates.map(c => ({ id: c.id, status: "confirmed", reason: "real source fixture" })) }) };
  } }, limits, 0);
  assert.equal(checked.kept.length, 1, `${kind} locations can be verified using actual repository evidence`);
  const blocked = await verifyPrNode(node, { ...common, store: memoryPipelineStore(), ask: async () => { throw new ExecutionBudgetError("token_limit"); } }, limits, 0);
  assert.equal(blocked.issues[0].reason, "token_limit");
  assert.equal(blocked.issues[0].retryable, false);
  const transient = await verifyPrNode(node, { ...common, store: memoryPipelineStore(), ask: async () => { throw new LlmRequestError("timeout", "provider_timeout", true); } }, limits, 0);
  assert.equal(transient.issues[0].retryable, true);
  for (const reason of ["daily_tokens", "deadline"] as const) {
    const waiting = await verifyPrNode(node, { ...common, store: memoryPipelineStore(), ask: async () => { throw new ExecutionBudgetError(reason); } }, limits, 0);
    assert.equal(waiting.issues[0].reason, reason);
    assert.equal(waiting.issues[0].retryable, true, `${reason} during independent verification must automatically resume`);
  }
}
console.log("ok PR evidence: minimal diff hunks, complete citation ranges, deleted-file base, invalid numeric ranges, data/document/other provenance and typed retryability");
