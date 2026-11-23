import assert from "node:assert/strict";
import { diffSources, type DiffChange, type ReviewRepository } from "@/lib/curator/pr-full-diff";
import { sourceUnit, unitText } from "@/lib/curator/context-parts";
import { createWholeFileReader } from "@/lib/agent/whole-file-reader";
import { collectPrEvidence, renderPrEvidence } from "@/lib/curator/pr-evidence";
import { formatChanges } from "@/lib/curator/context";
import { snapshotExclusion } from "@/lib/curator/snapshot-policy";
import { ExecutionBudget } from "@/lib/llm/execution";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTools, createToolLog } from "@/lib/agent/tools.mjs";

const marker = "RESTRICTED_VALUES_MUST_NOT_REACH_MODEL";
const paths = ["data.CSV", "data.tsv", "data.parquet", "data.xlsx", "data.pkl", "data.hdf5", "data.npy", "data.sdf", "data.pdbqt",
  "data.smi", "data.sqlite", "records.jsonl", "records.ndjson", "run.log", "package-lock.json", "pnpm-lock.yaml", "bundle.min.js",
  "bundle.js.map", ".env", "secret.pem", "plot.svg", "weights.pt", "node_modules/source.ts", "dist/output.py",
  "data/raw/reads.fastq", "sample.FASTA", "data/raw/dump.json", "raw.txt", "saved.mhtml", "export.html"];
for (const path of ["generate.py", "readme.TXT", "dvc.yaml", "configs/tsconfig.node.json", "pom.xml", "script.mts", "Snakefile"]) {
  assert.equal(snapshotExclusion(path), null, path);
}
const base = "a".repeat(40), head = "b".repeat(40);
const limits = { contextTokens: 128000, outputTokens: 1000 };
const budget = new ExecutionBudget({ maxTokens: 950000, deadlineAt: Date.now() + 60000 });
for (const path of paths) {
  assert.ok(snapshotExclusion(path), path);
  for (const [oldPath, newPath, status] of [[path, path, "A"], [path, path, "D"], [path, path, "M"], [path, "renamed.py", "R100"], ["renamed.py", path, "R100"]]) {
    const change: DiffChange = { oldPath, newPath, status, oldBlob: base, newBlob: head, oldMode: "100644", newMode: "100644" };
    const patch = `diff --git a/${oldPath} b/${newPath}\n--- a/${oldPath}\n+++ b/${newPath}\n@@ -1 +1 @@\n-${marker}\n+${marker}\n`;
    const sources = diffSources(Buffer.from(patch), [change], "policy-test");
    const text = await unitText(sourceUnit(sources[0]));
    assert.ok(!text.includes(marker), `${path}: ${status} diff leaked`);
    assert.ok(sources[0].omittedReason, `${path}: missing exclusion diagnostic`);
    assert.equal(sources[0].hunks.length, 0);
  }
  let reads = 0;
  const repository: ReviewRepository = { base, head, mergeBase: base, changes: [], sources: [], readFile: async () => { reads++; throw new Error("must not load restricted content"); } };
  const reader = createWholeFileReader({ repository, limits, budget, withResult: result => result, futureReserve: () => 0 });
  assert.equal((await reader.read(path, "head")).status, "denied");
  assert.equal((await reader.read(path, "base")).status, "denied");
  // A durable file from the former permissive runtime must not enter verification.
  const cached = { status: "ok" as const, path, revision: "head" as const, sha: head, text: marker };
  const evidence = await collectPrEvidence({ units: [], files: [cached] }, [{ kind: "file", target: path, detail: "1" }], [],
    repository, limits, budget, 0, proof => [{ role: "user", content: renderPrEvidence(proof) }]);
  assert.equal(evidence.files.length, 0);
  assert.ok(evidence.issues.length);
  assert.ok(!JSON.stringify(evidence.messages).includes(marker), `${path}: cached verification leaked`);
  assert.equal(reads, 0);
  repository.changes = [{ oldPath: path, newPath: "renamed.py", status: "R100", oldMode: "100644", newMode: "100644", oldBlob: base, newBlob: head }];
  const renamedReader = createWholeFileReader({ repository, limits, budget, withResult: result => result, futureReserve: () => 0 });
  assert.equal((await renamedReader.read("renamed.py")).status, "denied", `${path}: rename bypassed whole-file policy`);
  assert.equal(reads, 0);
  const legacy = await formatChanges([{ filename: path, status: "added", additions: 1, deletions: 0, patch: `@@\n+${marker}` }], 1, async () => marker);
  assert.ok(!legacy.text.includes(marker), `${path}: legacy diff leaked`);
}
const root = await mkdtemp(join(tmpdir(), "policy-tools-"));
try {
  await mkdir(join(root, "node_modules"));
  for (const path of [".env", "image.svg", "node_modules/leak.ts"]) await writeFile(join(root, path), marker);
  await writeFile(join(root, "data.csv"), "column\n" + Array.from({ length: 30 }, (_, i) => i === 29 ? marker : String(i)).join("\n"));
  const tools = Object.fromEntries(createTools(root, createToolLog()).map(tool => [tool.name, tool]));
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tools[name].execute("policy-test", args as never);
    return result.content.map(c => c.type === "text" ? c.text : "").join("\n");
  };
  for (const path of [".env", "image.svg", "node_modules/leak.ts"]) {
    await assert.rejects(call("read_file", { path }), /excluded by policy/);
    await assert.rejects(call("grep", { path, text: marker }), /excluded by policy/);
  }
  assert.ok(!(await call("grep", { text: marker })).includes(marker));
  await assert.rejects(call("read_file", { path: "data.csv", from: 30, to: 31 }), /excluded by policy/);
  assert.equal(tools.table_info, undefined);
  await writeFile(join(root, "dump.json"), JSON.stringify({ value: marker }));
  await assert.rejects(call("json_get", { path: "dump.json", key: "/value" }), /excluded by policy/);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("ok file policy: restricted diff additions/deletions/renames, head/base reads, cached verification and legacy diff");
