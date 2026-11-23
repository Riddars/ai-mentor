import assert from "node:assert/strict";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { diffSources, type DiffChange, type ReviewRepository } from "@/lib/curator/pr-full-diff";
import { buildPriorGroups, checkPriorGroups } from "@/lib/curator/pr-prior";
import { memoryPipelineStore } from "@/lib/curator/pipeline-store";
import { ExecutionBudget } from "@/lib/llm/execution";
import type { PrPipelineOptions } from "@/lib/curator/pr-pipeline";
import type { PriorFinding, DismissedFinding } from "@/lib/curator/store";

const change: DiffChange = { oldMode: "100644", newMode: "100644", oldBlob: "a".repeat(40), newBlob: "b".repeat(40), status: "M", oldPath: "package.json", newPath: "package.json" };
const repository: ReviewRepository = { base: "a".repeat(40), mergeBase: "a".repeat(40), head: "b".repeat(40), changes: [change],
  sources: diffSources(Buffer.from("diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-old\n+new\n"), [change], "fixture"),
  readFile: async path => ({ path, mode: "100644", revision: "b".repeat(40), blob: "b".repeat(40), bytes: Buffer.from("new") }) };
const prior = Array.from({ length: 50 }, (_, i): PriorFinding => ({ id: i + 1, prNumber: 1, area: "data", severity: "important", title: `Issue ${i}`,
  verify: "must be fixed", status: i % 2 ? "pending" : "open", locations: [{ kind: "data", target: "package.json", detail: "1" }] }));
const human: DismissedFinding = { ...prior[0], id: 100, status: "dismissed", reason: "human decision", byPerson: true };
const modelDismissed: DismissedFinding = { ...human, id: 101, byPerson: false };
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
let calls = 0;
const options: PrPipelineOptions = { repository, context: "fixture", primary: { provider: "fixture", model: faux.getModel(), stream: models.streamSimple.bind(models), contextTokens: 128000 },
  budget: new ExecutionBudget({ maxTokens: 950000, deadlineAt: Date.now() + 60000 }), store: memoryPipelineStore(), prior, dismissed: [human, modelDismissed],
  ask: async messages => {
    calls++;
    const data = JSON.parse(messages[1].content.split("\nИсходные материалы:\n")[0]) as { priors: Array<{ id: number; status: string }> };
    assert.ok(data.priors.every(p => p.id !== 100));
    assert.equal((messages[1].content.match(/\+new/g) ?? []).length, 1, "shared source is sent once for a group of prior findings");
    return { provider: "fixture", model: "fixture", usage: { input: 1, output: 1 }, content: JSON.stringify({ verdicts: data.priors.map(p => ({ id: p.id,
      status: p.status === "dismissed" ? "reopened" : "closed", reason: "source-backed fixture" })) }) };
  } };
const limits = { contextTokens: 128000, outputTokens: 8000 };
const groups = await buildPriorGroups(options, limits);
assert.equal(groups.length, 1);
const plan = await checkPriorGroups(groups, options, limits, true);
assert.ok(plan.cost > 0);
assert.equal(calls, 0);
const checked = await checkPriorGroups(groups, options, limits);
assert.equal(calls, 1);
assert.equal(checked.findings.length, 51);
assert.ok(checked.findings.some(f => f.priorId === 101 && f.status === "reopened"));
assert.ok(!checked.findings.some(f => f.priorId === 100));
assert.equal(prior[1].status, "pending", "proposal never mutates the input state");
assert.equal((await checkPriorGroups(groups, options, limits, true)).cost, 0);
await checkPriorGroups(groups, options, limits);
assert.equal(calls, 1, "durable verdicts reused without new calls");
console.log("ok former findings: 51 criteria share one source request, manual dismissal protected, model dismissal can reopen, pending preserved until apply, cost planning and checkpoint reuse");
