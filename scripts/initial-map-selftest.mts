import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildInitialSnapshot, runInitialMap } from "@/lib/curator/initial-map";
import { ExecutionBudget } from "@/lib/llm/execution";

const root = await mkdtemp(join(tmpdir(), "initial-map-test-"));
try {
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "src"));
  const source = Array.from({ length: 501 }, (_, i) => `line_${i}`).join("\n");
  await writeFile(join(root, "src", "main.py"), source);
  for (const [name, content] of Object.entries({ "README.md": "Repository description", "table.csv": "SECRET_DATA",
    ".env": "SECRET_KEY", "receptor.pdbqt": "MOLECULE_DATA", "package-lock.json": "LOCK_DATA", "image.png": "IMAGE_DATA" })) {
    await writeFile(join(root, name), content);
  }
  await writeFile(join(root, ".git", "config"), "GIT_SECRET");
  await writeFile(join(root, "work.ipynb"), JSON.stringify({ cells: [{ cell_type: "code", source: ["print(123)"], outputs: ["HUGE_OUTPUT"] }] }));
  const packed = await buildInitialSnapshot(root);
  assert.equal(packed.included.length, 3);
  assert.ok(packed.text.includes(source), "entire 501-line source, no excerpts");
  assert.equal(packed.text.split(source).length, 2, "source appears exactly once");
  assert.ok(packed.text.includes("print(123)"));
  for (const excluded of ["SECRET_DATA", "SECRET_KEY", "LOCK_DATA", "IMAGE_DATA", "GIT_SECRET", "HUGE_OUTPUT", "MOLECULE_DATA"]) assert.ok(!packed.text.includes(excluded));
  const events: unknown[] = [];
  const result = await runInitialMap(root, "map project", new ExecutionBudget({ maxTokens: 950000, deadlineAt: Date.now() + 60000 }),
    event => { events.push(event); }, async messages => {
      assert.equal(messages.length, 2);
      assert.ok(messages[1].content.includes(source));
      return { content: JSON.stringify({ summary: "Проект", findings: [], notes: "Карта проекта" }), provider: "fixture", model: "fixture", usage: { input: 100, output: 10 } };
    });
  assert.equal(result.reply.toolCalls, 0);
  assert.equal(result.reply.steps, 1);
  assert.equal(result.reply.viewed.length, 3);
  assert.equal(events.length, 1);
  process.env.INITIAL_MAP_CONTEXT_TOKENS = "16000";
  await writeFile(join(root, "src", "large.ts"), "x".repeat(60000));
  let called = false;
  await assert.rejects(runInitialMap(root, "map", new ExecutionBudget({ maxTokens: 950000, deadlineAt: Date.now() + 60000 }), () => {}, async () => {
    called = true; throw new Error("must not call provider");
  }), /does not fit/);
  assert.equal(called, false, "oversized input is rejected before any paid call");
  console.log("ok initial map: full source once, excluded data/secrets/generated files, notebook cells, one no-tool request, context overflow rejected before dispatch");
} finally { delete process.env.INITIAL_MAP_CONTEXT_TOKENS; await rm(root, { recursive: true, force: true }); }
