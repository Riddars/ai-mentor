import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertUnitCoverage, hashText, packContext, rebuildPartRequest, sourceUnit, unitText, type ContextSource, type PackOptions } from "@/lib/curator/context-parts";
import { measureContext, type TokenCounter } from "@/lib/curator/context-size";
import { repositoryInventory } from "@/lib/curator/repository-inventory";

const counter: TokenCounter = { name: "fixture-utf8", exact: true, count: text => Buffer.byteLength(text) };
function source(path: string, text: string): ContextSource {
  const bytes = Buffer.from(text);
  const viewHash = hashText(bytes);
  return { id: hashText(path + viewHash), path, revision: "sha", kind: "fixture", bytes: bytes.length,
    originalHash: viewHash, viewHash, transformation: "identity", read: async (from, to) => bytes.subarray(from, to) };
}
const options: PackOptions<Array<{ role: string; content: string }>> = {
  limits: { contextTokens: 1200, outputTokens: 100, safetyRatio: 0 }, counter, version: "test-v1",
  template: async units => [{ role: "system", content: "immutable rules" }, { role: "user", content: (await Promise.all(units.map(async u =>
    JSON.stringify({ path: u.source.path, from: u.from, to: u.to, text: await unitText(u) })))).join("\n") }],
};
assert.equal(measureContext({ text: "abc" }, options.limits, counter).estimated, false);
assert.equal(measureContext({ text: "abc" }, options.limits).estimated, true);
assert.throws(() => measureContext({}, { contextTokens: NaN, outputTokens: 10 }), /Invalid/);
assert.throws(() => measureContext({}, options.limits, { ...counter, count: () => -1 }), /Invalid/);
const inputs = [source("README.md", "hello"), source("源/emoji.cs", "\uFEFF" + "😀中文\r\n".repeat(1000) + "last-no-newline"), source("long.json", "x".repeat(12000)), source("empty", "")];
const parts = await packContext(inputs, options);
assert.ok(parts.length > 10);
assertUnitCoverage(inputs.map(s => sourceUnit(s)), parts.flatMap(p => p.units));
for (const s of inputs) {
  const recovered = Buffer.concat(await Promise.all(parts.flatMap(p => p.units).filter(u => u.source.id === s.id).map(u => s.read(u.from, u.to))));
  assert.equal(hashText(recovered), s.viewHash, "byte-exact reconstruction including BOM, CRLF and final incomplete line");
}
for (const part of parts) assert.ok(measureContext(await rebuildPartRequest(part, options), options.limits, counter).fits);
assert.deepEqual((await packContext(inputs, options)).map(p => p.id), parts.map(p => p.id), "stable deterministic IDs");
const units = parts.flatMap(p => p.units);
assert.throws(() => assertUnitCoverage(inputs.map(s => sourceUnit(s)), units.slice(1)), /Coverage/);
assert.throws(() => assertUnitCoverage(inputs.map(s => sourceUnit(s)), [...units, units[0]]), /Coverage/);
await assert.rejects(rebuildPartRequest(parts[0], { ...options, template: async () => [{ role: "user", content: "changed" }] }), /changed/);
await assert.rejects(packContext(inputs, { ...options, limits: { contextTokens: 30, outputTokens: 25 } }), /mandatory context/);
await assert.rejects(packContext([source("huge", "x".repeat(2000))], { ...options, split: async u => [u] }), /no progress/);
await assert.rejects(packContext([source("huge", "x".repeat(2000))], { ...options, split: async u => [sourceUnit(u.source, 0, 5), sourceUnit(u.source, 6, u.to)] }), /gap/);
// Deterministic property cases: all Unicode byte boundaries must decode and cover exactly once.
for (let seed = 1; seed <= 40; seed++) {
  const text = Array.from({ length: seed * 35 }, (_, i) => ["😀", "я", "中", "\r\n", "\\\"", "a"][((i * 17) + seed) % 6]).join("");
  const s = source(`case-${seed}`, text);
  const packed = await packContext([s], options);
  assert.equal((await Promise.all(packed.flatMap(p => p.units).map(unitText))).join(""), text);
}
const directory = await mkdtemp(join(tmpdir(), "context-parts-"));
try {
  const root = join(directory, "repo"), scratch = join(directory, "views");
  await mkdir(root); await mkdir(scratch); await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "config"), "secret");
  await writeFile(join(root, "README.md"), "\uFEFFпривет\r\nno-final-newline");
  await writeFile(join(root, "table.csv"), "do-not-send");
  await writeFile(join(root, ".env"), "API_KEY=secret");
  await writeFile(join(root, "binary.dat"), Buffer.from([255, 0, 2]));
  await writeFile(join(root, "work.ipynb"), JSON.stringify({ cells: [{ cell_type: "code", source: ["print(1)"], outputs: [{ text: "not-in-view" }] }] }));
  const inventory = await repositoryInventory(root, "commit", scratch);
  assert.equal(inventory.sources.filter(s => s.kind === "file").length, 2);
  const readme = inventory.sources.find(s => s.path === "README.md")!;
  assert.equal(readme.originalHash, readme.viewHash);
  assert.equal(await unitText(sourceUnit(readme)), "\uFEFFпривет\r\nno-final-newline");
  const notebook = inventory.sources.find(s => s.path === "work.ipynb")!;
  assert.notEqual(notebook.originalHash, notebook.viewHash);
  assert.ok(!(await unitText(sourceUnit(notebook))).includes("not-in-view"));
  assert.equal(inventory.excluded.find(s => s.path === "table.csv")?.bytes, 11);
  const table = inventory.sources.find(s => s.path === "table.csv")!;
  assert.equal(table.kind, "metadata");
  assert.ok(!(await unitText(sourceUnit(table))).includes("do-not-send"));
  assert.equal(inventory.excluded.length, 4);
  await assert.rejects(repositoryInventory(root, "commit", root), /outside/);
} finally { await rm(directory, { recursive: true, force: true }); }
console.log(`ok context preparation: ${parts.length} parts, exact Unicode coverage, bounded UTF8 split, stable identity, admission, corruption detection, 40 property fixtures, safe disk inventory`);
