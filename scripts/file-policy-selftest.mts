import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolLog, createTools } from "@/lib/agent/tools.mjs";
import { formatChanges } from "@/lib/curator/context";

const root = mkdtempSync(join(tmpdir(), "curator-policy-"));
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
try {
  writeFileSync(join(root, "data.csv"), `name,value\n${Array.from({ length: 60 }, (_, i) => `sample${i},${i}`).join("\n")}`);
  writeFileSync(join(root, "records.jsonl"), Array.from({ length: 30 }, (_, i) => JSON.stringify({ id: i, value: `sample${i}` })).join("\n"));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/demo": { version: "1.2.3" } }, padding: "x".repeat(45_000) }));
  writeFileSync(join(root, "run.log"), Array.from({ length: 100 }, (_, i) => `event ${i}`).join("\n"));
  writeFileSync(join(root, "code.py"), Array.from({ length: 55 }, (_, i) => `value_${i} = ${i}`).join("\n"));
  writeFileSync(join(root, "long.lock"), `${"x".repeat(400)} demo-package@1.2.3\n`);
  writeFileSync(join(root, "package.json"), JSON.stringify({ runs: Array.from({ length: 1500 }, (_, i) => ({ seed: i, metrics: { score: i / 1500 } })), summary: { best: 1499 } }));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ experiment: { runs: Array.from({ length: 3000 }, (_, i) => ({ seed: i, score: i })) } }));
  writeFileSync(join(root, "jsconfig.json"), JSON.stringify({ "test.accuracy": 0.91, "model name": "demo", "a/b": { "~metric": 7 } }));
  writeFileSync(join(root, "pom.xml"), `<report>${Array.from({ length: 3000 }, (_, i) => `<run id="${i}"><score>${i}</score><loss>${i + 1}</loss></run>`).join("")}</report>`);
  writeFileSync(join(root, "report.html"), `<html><head><title>Experiment</title><script>${"x".repeat(50_000)}</script></head><body><h1>Results</h1><table><tr><td>score</td></tr></table></body></html>`);
  const tools = Object.fromEntries(createTools(root, createToolLog()).map((tool) => [tool.name, tool]));
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tools[name].execute("test", args as never);
    return result.content.map((part) => part.type === "text" ? part.text : "").join("");
  };
  assert(!(await call("grep", { text: "sample" })).includes("data.csv:"), "CSV leaked through grep");
  assert(!(await call("grep", { text: "sample" })).includes("records.jsonl:"), "JSONL leaked through grep");
  for (const path of ["data.csv", "records.jsonl", "package-lock.json", "run.log", "long.lock", "report.html"]) {
    const result = await call("read_file", { path }).catch((error: Error) => error.message);
    assert(result.includes("excluded by policy"), `Unexpected content for ${path}`);
  }
  const json = await call("read_file", { path: "package.json" });
  assert(json.includes("$.runs: 1500 элементов") && !json.includes('"seed":1499'), `large JSON summary incorrect: ${json.slice(0, 500)}`);
  assert((await call("json_info", { path: "tsconfig.json" })).includes("$.experiment.runs: 3000 элементов"), "nested JSON array summary incorrect");
  assert((await call("json_get", { path: "package.json", key: "$.runs.17.metrics" })).includes("score"), "JSON path lookup failed");
  assert((await call("json_get", { path: "jsconfig.json", key: "/test.accuracy" })).includes("0.91"), "dotted JSON key lookup failed");
  assert((await call("json_get", { path: "jsconfig.json", key: "/a~1b/~0metric" })).includes("7"), "escaped JSON Pointer lookup failed");
  assert((await call("xml_info", { path: "pom.xml" })).includes("3000 элементов"), "XML summary incorrect");
  const xml = await call("xml_get", { path: "pom.xml", element: "report/run", index: 17 });
  assert(xml.includes("id=\"17\"") && xml.includes("<score>17</score><loss>18</loss>"), "XML element lookup failed");
  const page1 = await call("grep", { path: "code.py", text: "value", offset: 0 });
  const page2 = await call("grep", { path: "code.py", text: "value", offset: 20 });
  assert(page1.includes("найдено более 20") && !page1.includes("code.py:21:"), "first search page incorrect");
  assert(page2.includes("code.py:21:") && !page2.includes("code.py:41:"), "second search page incorrect");
  const changes = await formatChanges([{ filename: "package-lock.json", status: "modified", additions: 1, deletions: 1, patch: "@@ secret lock contents" }], 1, async () => null);
  assert(!changes.text.includes("secret lock contents"), "lock diff leaked");
  const summary = await formatChanges([{ filename: "package-lock.json", status: "modified", additions: 2, deletions: 0, patch: '@@\n+    "node_modules/demo": {\n+      "version": "1.2.3"\n' }], 1, async () => null);
  assert(!summary.text.includes("node_modules/demo") && !summary.text.includes("1.2.3"), "dependency diff leaked");
  writeFileSync(join(root, "large.py"), Array.from({ length: 500 }, (_, i) => `line_${i} = "${"x".repeat(300)}"`).join("\n"));
  const cappedLog = createToolLog();
  const capped = Object.fromEntries(createTools(root, cappedLog).map((tool) => [tool.name, tool]));
  const cappedRead = async (args: Record<string, unknown>) => {
    const result = await capped.read_file.execute("test", { path: "large.py", ...args } as never);
    return result.content.map((part) => part.type === "text" ? part.text : "").join("");
  };
  for (let i = 0; i < 3; i++) await cappedRead({ from: 1, to: 400 });
  assert((await cappedRead({ from: 1, to: 400 })).includes("Лимит текста"), "shared output cap missing");
  assert((await cappedRead({ from: 499, to: 500 })).includes("500\t"), "short evidence read blocked");
  writeFileSync(join(root, "unread.py"), "not actually viewed\n");
  for (let i = 0; i < 100; i++) await cappedRead({ from: 499, to: 500 });
  const refused = await capped.read_file.execute("test", { path: "unread.py" } as never);
  assert(refused.content.some((part) => part.type === "text" && part.text.includes("Лимит текста")), "exhausted budget did not refuse");
  assert(!cappedLog.viewed.has("unread.py"), "refused file counted as viewed");
  console.log("file policy checks passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
