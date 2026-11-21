/** Run without network or model keys: npx tsx scripts/research-state-selftest.mts
 * Scripted responses test the harness, not the scientific quality of model findings. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addEvidenceRead, createResearchState, finishResearch, researchComplete, researchContext, saveResearchNotes,
} from "@/lib/agent/research";
import { createToolLog, createTools } from "@/lib/agent/tools.mjs";
import { runAgent } from "@/lib/agent/agent.mjs";
import { overviewMemory } from "@/lib/agent/overview-agent.mjs";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";

let checks = 0;
function check(name: string, test: () => void): void {
  test();
  checks += 1;
  console.log(`ok ${name}`);
}

const state = createResearchState();
check("new state has no authored notes, evidence or completion", () => {
  assert.equal(state.version, 1);
  assert.equal(researchComplete(state), false);
  assert.equal(state.revision, 0);
});
const one = addEvidenceRead(state, { path: "project.any", kind: "text", from: 1, to: 1, content: "1\tinput => output", truncated: false });
check("evidence identity is deterministic and repeated reads are not progress", () => {
  const again = addEvidenceRead(state, { path: "project.any", kind: "text", from: 1, to: 1, content: "1\tinput => output", truncated: false });
  assert.equal(again.id, one.id);
  assert.equal(state.revision, 1);
  assert.equal(state.reads.length, 1);
});
check("unread refs cannot mutate good notes", () => {
  saveResearchNotes(state, "Known authored facts.");
  assert.throws(() => saveResearchNotes(state, "Erase those facts.", [{ question: "What is the input?", status: "checked", evidence: ["r999"], rationale: "The input has been inspected in the actual source." }]), /unread evidence/);
  assert.equal(state.notes, "Known authored facts.");
});
check("JSON or one unsupported self-declaration cannot complete an overview", () => {
  assert.equal(finishResearch(state, "I read everything.", []).complete, false);
  saveResearchNotes(state, "Known authored facts.", [{ question: "What is the input?", status: "checked", evidence: [one.id], rationale: "The single source declares the input expression explicitly." }]);
  assert.equal(finishResearch(state, "Checked the input.", []).complete, false);
});
check("two independent checks can share a one-line repository", () => {
  saveResearchNotes(state, "Known authored facts.", [{ question: "What is the produced output?", status: "checked", evidence: [one.id], rationale: "The output follows directly from the same inspected expression." }]);
  assert.equal(finishResearch(state, "Checked input and output separately.", []).complete, true);
  assert.equal(researchComplete(state), true);
  assert.equal(state.notes, "Known authored facts.");
});
check("new reading invalidates completion and preserves old identities", () => {
  addEvidenceRead(state, { path: "project.any", kind: "text", from: 2, to: 2, content: "2\tother result", truncated: false });
  assert.equal(researchComplete(state), false);
  assert.equal(state.reads[0].id, one.id);
});
check("pending questions and explicit material gaps prevent full completion", () => {
  saveResearchNotes(state, "Known authored facts.", [{ question: "How is the result checked?", status: "pending" }]);
  assert.equal(finishResearch(state, "Some checks are still missing.", []).complete, false);
  assert.equal(finishResearch(state, "Some checks are still missing.", ["Result validation unavailable."]).complete, false);
  assert.equal(state.gaps[0], "Result validation unavailable.");
});
check("rereads and copied rationales cannot manufacture independent checks", () => {
  const repeated = createResearchState();
  const read = addEvidenceRead(repeated, { path: "one.any", kind: "text", from: 1, to: 1, content: "1\tinput => output", truncated: false });
  for (let index = 0; index < 8; index += 1) addEvidenceRead(repeated, { path: "one.any", kind: "text", from: 1, to: 1, content: "1\tinput => output", truncated: false });
  saveResearchNotes(repeated, "One source has been inspected.", [
    { question: "What is the input format?", status: "checked", evidence: [read.id], rationale: "The same generic check does not establish independent verification." },
    { question: "What output is produced?", status: "checked", evidence: [read.id], rationale: "The same generic check does not establish independent verification." },
  ]);
  assert.equal(repeated.reads.length, 1);
  assert.equal(finishResearch(repeated, "Copied checks are not enough.", []).complete, false);
});
check("listing/search results alone never support full completion", () => {
  const discovery = createResearchState();
  const map = addEvidenceRead(discovery, { path: ".", kind: "listing", content: "file.any", truncated: false });
  saveResearchNotes(discovery, "Only the map is known.", [
    { question: "What material exists?", status: "checked", evidence: [map.id], rationale: "The map names one file but does not reveal its actual contents." },
    { question: "What output is produced?", status: "checked", evidence: [map.id], rationale: "The available file name cannot establish the produced output." },
  ]);
  assert.equal(finishResearch(discovery, "Only discovery happened.", []).complete, false);
});
check("bounded excerpts never drop ledger metadata, selectors or IDs", () => {
  const large = createResearchState();
  for (let index = 0; index < 50; index += 1) addEvidenceRead(large, {
    path: "records.json", kind: "json_value", selector: `/records/${index}`, content: "x".repeat(6_000), truncated: false,
  });
  assert.equal(large.reads.length, 50);
  assert.ok(large.reads.reduce((sum, read) => sum + read.content.length, 0) <= 48_000);
  assert.equal(large.reads.at(-1)?.selector, "/records/49");
  assert.equal(large.reads.at(-1)?.contentTruncated, true);
  assert.ok(researchContext(large).includes('"id":"r50"'));
  saveResearchNotes(large, "AUTHORED_NOTES_PRESERVED_ONCE", [
    { question: "What is in the first inspected record?", status: "checked", evidence: ["r1"], rationale: "The first exact selector identifies the initial inspected material." },
    { question: "What is in the last inspected record?", status: "checked", evidence: ["r50"], rationale: "The final exact selector identifies a separate inspected record." },
  ]);
  const rebuilt = JSON.parse(overviewMemory(large)) as typeof large;
  assert.deepEqual(rebuilt.reads.map(read => [read.id, read.path, read.selector]), large.reads.map(read => [read.id, read.path, read.selector]));
  assert.deepEqual(rebuilt.questions, large.questions);
  assert.equal(overviewMemory(large).split("AUTHORED_NOTES_PRESERVED_ONCE").length - 1, 1);
});

const root = await mkdtemp(join(tmpdir(), "curator-research-state-"));
try {
  await writeFile(join(root, "workflow.any"), Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n"));
  await writeFile(join(root, "long.any"), Array.from({ length: 350 }, () => "z".repeat(490)).join("\n"));
  await writeFile(join(root, "records.json"), JSON.stringify({ records: Array.from({ length: 2_000 }, (_, index) => ({ id: index, value: "v".repeat(20) })) }));
  await writeFile(join(root, "records.csv"), "id,value\n" + Array.from({ length: 50 }, (_, index) => `${index},value${index}`).join("\n"));
  await writeFile(join(root, "run.log"), Array.from({ length: 100 }, (_, index) => `event ${index + 1}`).join("\n"));
  await writeFile(join(root, "study.ipynb"), JSON.stringify({ cells: [
    { cell_type: "markdown", source: ["Study description\n"] }, { cell_type: "code", source: ["result = input_value\n"], outputs: [] },
  ] }));
  await mkdir(join(root, "nested"));
  const log = createToolLog();
  log.notes = "Automatic summary is separate.";
  const tools = Object.fromEntries(createTools(root, log, true).map(tool => [tool.name, tool]));
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tools[name].execute("test", args as never);
    return result.content.map(part => part.type === "text" ? part.text : "").join("");
  };
  const first = await call("read_file", { path: "workflow.any" });
  check("overview default is 80 actual lines with a next-range hint", () => {
    assert.ok(first.includes("[r1]"));
    assert.ok(first.includes("80\tline 80"));
    assert.ok(!first.includes("81\tline 81"));
    assert.ok(first.includes("from=81, to=160"));
    assert.equal(log.research?.reads[0].from, 1);
    assert.equal(log.research?.reads[0].to, 80);
  });
  const duplicate = await call("read_file", { path: "./workflow.any", from: 1, to: 80 });
  check("equivalent default/explicit reads return short references without new evidence", () => {
    assert.ok(duplicate.includes("Уже прочитано: [r1]"));
    assert.ok(!duplicate.includes("80\tline 80"));
    assert.equal(log.research?.reads.length, 1);
  });
  const reread = await call("read_file", { path: "workflow.any", from: 1, to: 80, reason: "Restore the exact input before checking its interpretation." });
  check("an explicit reason restores full text without manufacturing progress", () => {
    assert.ok(reread.includes("80\tline 80"));
    assert.equal(log.research?.reads.length, 1);
  });
  await call("read_file", { path: "workflow.any", from: 81, to: 120 });
  const clipped = await call("read_file", { path: "long.any", from: 1, to: 350 });
  const clippedRead = log.research!.reads.at(-1)!;
  check("output clipping records only line numbers actually returned", () => {
    assert.ok(clippedRead.to! < 350);
    assert.equal(clippedRead.truncated, true);
    assert.ok(clipped.includes(`from=${clippedRead.to! + 1}`));
  });
  const clippedAgain = await call("read_file", { path: "long.any", from: 1, to: 350 });
  check("clipped requests still cache by their original request", () => assert.ok(clippedAgain.includes(`Уже прочитано: [${clippedRead.id}]`)));
  await call("read_file", { path: "records.json" });
  const summaryRead = log.research!.reads.at(-1)!;
  await call("json_get", { path: "records.json", key: "/records/7/id" });
  const valueRead = log.research!.reads.at(-1)!;
  check("a structured summary is distinct from a concrete selected value", () => {
    assert.equal(summaryRead.kind, "json_summary");
    assert.equal(summaryRead.from, undefined);
    assert.equal(valueRead.kind, "json_value");
    assert.equal(valueRead.selector, "/records/7/id");
    assert.notEqual(summaryRead.id, valueRead.id);
  });
  await call("read_file", { path: "records.csv", from: 30, to: 45 });
  check("data previews record the actual first 20 lines rather than requested rows", () => {
    const data = log.research!.reads.at(-1)!;
    assert.equal(data.kind, "data_preview");
    assert.equal(data.from, 1);
    assert.equal(data.to, 20);
  });
  const beforeDenied = log.research!.reads.length;
  await assert.rejects(call("read_file", { path: "../outside.any" }));
  await assert.rejects(call("read_file", { path: "workflow.any", from: 20, to: 1 }));
  await assert.rejects(call("read_file", { path: "workflow.any", reason: "again" }));
  check("denied paths, invalid ranges and empty reread reasons add no evidence", () => assert.equal(log.research!.reads.length, beforeDenied));
  await call("save_review_notes", { notes: "The workflow input and output have been checked.", questions: [
    { question: "How is workflow input represented?", status: "checked", evidence: ["r1"], rationale: "The first inspected range establishes the input representation." },
    { question: "How is the output assembled?", status: "checked", evidence: ["r2"], rationale: "The following inspected range establishes output assembly separately." },
  ] });
  await call("finish_overview", { checked: "Verified the input representation and output assembly in the actual inspected workflow ranges, preserving precise references.", unresolved: [] });
  check("finish validates questions and does not overwrite authored notes or summary", () => {
    assert.equal(researchComplete(log.research!), true);
    assert.equal(log.notes, "Automatic summary is separate.");
    assert.equal(log.research!.notes, "The workflow input and output have been checked.");
    assert.ok(log.calls.some(entry => entry.tool === "save_review_notes"));
    assert.ok(log.calls.some(entry => entry.tool === "finish_overview"));
  });
  await call("read_file", { path: "workflow.any", from: 121, to: 160 });
  check("reading after finish invalidates both completion flags", () => {
    assert.equal(log.complete, false);
    assert.equal(researchComplete(log.research!), false);
  });
  await call("read_file", { path: "run.log" });
  check("log previews preserve disjoint head/tail ranges without claiming the middle", () => {
    const preview = log.research!.reads.at(-1)!;
    assert.equal(preview.kind, "log_preview");
    assert.equal(preview.from, undefined);
    assert.deepEqual(preview.ranges, [{ from: 1, to: 20 }, { from: 81, to: 100 }]);
    assert.equal(preview.truncated, true);
  });
  await call("read_file", { path: "study.ipynb" });
  check("notebook evidence uses the displayed cells representation", () => {
    const notebook = log.research!.reads.at(-1)!;
    assert.equal(notebook.kind, "notebook");
    assert.ok(notebook.content.includes("# [code]"));
    assert.ok(!notebook.content.includes('"cell_type"'));
  });
  const prLog = createToolLog();
  const prTools = Object.fromEntries(createTools(root, prLog).map(tool => [tool.name, tool]));
  const prFirst = await prTools.read_file.execute("pr", { path: "workflow.any" } as never);
  const prSecond = await prTools.read_file.execute("pr", { path: "workflow.any" } as never);
  check("PR mode keeps full 400-line default behavior and has no research cache", () => {
    assert.equal(prLog.research, undefined);
    assert.deepEqual(prFirst, prSecond);
    assert.ok(prFirst.content.some(part => part.type === "text" && part.text.includes("200\tline 200")));
  });

  // Exact read_file arguments from analysis21 (SHA 07522cb...): nine identical default
  // README reads, four repeats of 80–133, and one broad read. File contents are synthetic;
  // this fixture reproduces the historical request pattern without claiming to replay LLM reasoning.
  const historicalRequests: Array<{ path: string; from?: number; to?: number }> = [
    { path: "README.md" }, { path: "README.md", from: 80, to: 133 },
    { path: "README.md" }, { path: "README.md" }, { path: "README.md", from: 80, to: 133 },
    { path: "README.md", from: 1, to: 140 }, { path: "README.md" }, { path: "README.md" },
    { path: "README.md" }, { path: "README.md", from: 80, to: 133 },
    { path: "README.md" }, { path: "README.md" }, { path: "README.md", from: 80, to: 133 }, { path: "README.md" },
  ];
  try {
    const accepted = JSON.parse((await readFile(join(process.cwd(), "data/acceptance/analysis21.json"), "utf8")).replace(/^\uFEFF/, "")) as { agent_log: string };
    const archived = [...accepted.agent_log.matchAll(/^→ `read_file` (\{[^\n]+\})$/gm)]
      .map(match => JSON.parse(match[1]) as { path: string; from?: number; to?: number }).filter(args => args.path === "README.md");
    check("historical README fixture matches the supplied analysis21 trace", () => assert.deepEqual(archived, historicalRequests));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    console.log("skip optional original analysis21 artifact check; the historical request fixture is embedded");
  }
  const historicalRoot = join(root, "historical");
  await mkdir(historicalRoot);
  await writeFile(join(historicalRoot, "README.md"), Array.from({ length: 133 }, (_, index) => `Historical fixture line ${index + 1}`).join("\n"));
  const replayLog = createToolLog();
  const replayTool = createTools(historicalRoot, replayLog, true).find(tool => tool.name === "read_file")!;
  const replayOutput: string[] = [];
  for (const args of historicalRequests) {
    const reply = await replayTool.execute("historical", args as never);
    replayOutput.push(reply.content.map(part => part.type === "text" ? part.text : "").join(""));
  }
  const replayRevision = replayLog.research!.revision;
  const restored = await replayTool.execute("historical-reread", { path: "README.md", reason: "Check the exact wording before rejecting a candidate finding." } as never);
  check("analysis21 repeated README reads become references and explicit rereads restore content", () => {
    assert.equal(historicalRequests.filter(args => args.from === undefined).length, 9);
    assert.equal(replayLog.research!.reads.length, 3);
    assert.equal(replayOutput.filter(output => output.includes("Уже прочитано:")).length, 11);
    assert.equal(replayLog.research!.revision, replayRevision);
    assert.ok(restored.content.some(part => part.type === "text" && part.text.includes("80\tHistorical fixture line 80")));
    assert.equal(researchComplete(replayLog.research!), false);
  });

  for (const fixture of [
    { name: "unity", path: "Spinner.cs", tool: "read_file", source: "public class Spinner : MonoBehaviour { void Update() { transform.Rotate(0, 30 * Time.deltaTime, 0); } }",
      questions: [
        { question: "How is rotation advanced over time?", rationale: "Update advances rotation using Time.deltaTime in the inspected single source line." },
        { question: "Which scene object state is modified?", rationale: "The component changes its own transform through Rotate; no external data source is referenced." },
      ] },
    { name: "dataset", path: "measurements.csv", tool: "table_info", source: "sample_id,value,unit\na,1.5,mg\nb,2.0,mg\nc,3.5,mg",
      questions: [
        { question: "What is the observation structure?", rationale: "The table exposes sample_id, numerical value and unit columns for each observation." },
        { question: "What material is available for reproducibility?", rationale: "The inspected table contains three records and their unit; no processing pipeline is present in this repository." },
      ] },
  ]) {
    const fixtureRoot = join(root, fixture.name);
    await mkdir(fixtureRoot);
    await writeFile(join(fixtureRoot, fixture.path), fixture.source);
    const faux = fauxProvider();
    const models = createModels(); models.setProvider(faux.provider);
    const core = `SCIENTIFIC_CORE_${fixture.name}: findings require evidence and unfinished work is not a defect.`;
    const user = `ORIGINAL_REQUEST_${fixture.name}`;
    let finalInstructionsValid = false;
    let finalUserOccurrences = 0;
    const answer = JSON.stringify({ summary: fixture.name, findings: [], notes: "The checked repository structure is represented by its actual material." });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(fixture.tool, { path: fixture.path }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("save_review_notes", {
        notes: `Authored working notes for ${fixture.name}.`,
        questions: fixture.questions.map(question => ({ ...question, status: "checked", evidence: ["r1"] })),
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("finish_overview", {
        checked: "Verified the two independent main questions against the available repository material and preserved their separate concrete evidence-based rationales.", unresolved: [],
      }), { stopReason: "toolUse" }),
      context => {
        finalInstructionsValid = getCurrentSystemPrompt(context.messages).includes(core) && getCurrentTools(context.messages).length === 0;
        finalUserOccurrences = JSON.stringify(context.messages).split(user).length - 1;
        return fauxAssistantMessage(fauxText(answer));
      },
    ]);
    const reviewed = await runAgent({ root: fixtureRoot, overview: true, systemPrompt: core, userPrompt: user,
      models, model: faux.getModel(), limits: { maxToolCalls: 10, maxTokens: 200_000, timeoutMs: 60_000 } });
    check(`${fixture.name} single-file harness completes without a language-specific workflow template`, () => {
      assert.equal(reviewed.error, null);
      assert.equal(reviewed.partialReview, false);
      assert.equal(reviewed.log.research?.questions.length, 2);
      assert.equal(reviewed.log.research?.reads.length, 1);
      assert.equal(finalInstructionsValid, true);
      assert.equal(finalUserOccurrences, 1);
    });
  }
  const contextRoot = join(root, "context-rebuild");
  await mkdir(contextRoot);
  for (let index = 0; index < 4; index += 1) {
    await writeFile(join(contextRoot, `component-${index}.any`), Array.from({ length: 80 }, (_, row) => `component${index} row${row} ${"x".repeat(450)}`).join("\n"));
  }
  const contextProvider = fauxProvider();
  const contextModels = createModels(); contextModels.setProvider(contextProvider.provider);
  const originalUser = "ONE_ORIGINAL_USER_REQUEST_CONTEXT_REBUILD";
  const authoredNotes = "ONE_AUTHORED_STATE_NOTES_CONTEXT_REBUILD";
  let contextChecks = 0;
  let compactions = 0;
  const assertPairs = (messages: Array<{ role: string; content?: unknown; toolCallId?: string }>) => {
    const declared = new Set<string>();
    for (const message of messages) {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) if (part.type === "toolCall") declared.add(part.id);
      }
      if (message.role === "toolResult") assert.ok(declared.has(message.toolCallId!), "A tool result must retain its assistant call in the rebuilt tail.");
    }
  };
  const inspectContext = (context: { messages: Array<{ role: string; content: unknown; toolCallId?: string }> }) => {
    contextChecks += 1;
    assert.equal(JSON.stringify(context.messages).split(originalUser).length - 1, 1);
    const prompt = context.messages.find(message => message.role === "user")!.content as string;
    const memoryText = prompt.slice(prompt.indexOf("\n", prompt.indexOf("Состояние исследования")) + 1);
    const [memoryPart, tailPart] = memoryText.split("\nПоследние обмены:\n");
    const memory = JSON.parse(memoryPart) as typeof state;
    assert.deepEqual(memory.reads.map(read => read.id), Array.from({ length: memory.reads.length }, (_, index) => `r${index + 1}`));
    if (memory.questions.length) {
      assert.equal(memory.notes, authoredNotes);
      assert.deepEqual(memory.questions.map(question => question.evidence), [["r1"], ["r4"]]);
    }
    assertPairs(tailPart ? JSON.parse(tailPart) : context.messages);
  };
  const contextAnswer = JSON.stringify({ summary: "Rebuilt context preserves the research state.", findings: [], notes: "The main chain has been checked." });
  contextProvider.setResponses([
    ...Array.from({ length: 4 }, (_, index) => (context: TranscriptContext) => {
      inspectContext(context);
      return fauxAssistantMessage(fauxToolCall("read_file", { path: `component-${index}.any` }), { stopReason: "toolUse" });
    }),
    context => {
      inspectContext(context);
      return fauxAssistantMessage(fauxToolCall("save_review_notes", { notes: authoredNotes, questions: [
        { question: "How does the first component accept input?", status: "checked", evidence: ["r1"], rationale: "The first component's inspected source establishes its actual input handling." },
        { question: "How does the last component produce output?", status: "checked", evidence: ["r4"], rationale: "The last component's inspected source establishes a separate output step." },
      ] }), { stopReason: "toolUse" });
    },
    context => {
      inspectContext(context);
      return fauxAssistantMessage(fauxToolCall("finish_overview", {
        checked: "Verified the main input and output questions across the four components, preserved their exact read identities and checked the separate evidence-backed rationales.", unresolved: [],
      }), { stopReason: "toolUse" });
    },
    context => { inspectContext(context); return fauxAssistantMessage(fauxText(contextAnswer)); },
  ]);
  const rebuiltRun = await runAgent({ root: contextRoot, overview: true, systemPrompt: "Core scientific evidence rules are always active.", userPrompt: originalUser,
    models: contextModels, model: contextProvider.getModel(), limits: { maxToolCalls: 10, maxTokens: 800_000, timeoutMs: 60_000 },
    onUsage: (_input, _output, _evidence, extra) => { if (extra?.event?.type === "context_compacted") compactions += 1; } });
  check("actual rebuilt requests preserve every ID and question with complete exchanges and one original user request", () => {
    assert.equal(rebuiltRun.error, null);
    assert.equal(rebuiltRun.partialReview, false);
    assert.equal(contextChecks, 7);
    assert.ok(compactions > 0);
    assert.equal(rebuiltRun.log.research?.reads.length, 4);
    assert.equal(rebuiltRun.log.research?.questions.length, 2);
  });
  const emptyRoot = join(root, "empty");
  await mkdir(emptyRoot);
  const emptyLog = createToolLog();
  const emptyTools = Object.fromEntries(createTools(emptyRoot, emptyLog, true).map(tool => [tool.name, tool]));
  await emptyTools.list_files.execute("empty-map", {} as never);
  const emptyFinish = await emptyTools.finish_overview.execute("empty-finish", {
    checked: "There are no repository materials that can establish an actual processing workflow, data structure or result; only the empty root directory was observed.",
    unresolved: ["No material sources were available to substantiate the overview."],
  } as never);
  check("an empty copy reports an explicit material gap without fabricated completion", () => {
    assert.equal(researchComplete(emptyLog.research!), false);
    assert.equal(emptyLog.research!.gaps.length, 1);
    assert.ok(emptyFinish.content.some(part => part.type === "text" && part.text.includes("частичный")));
  });
} finally {
  assert.ok(root.startsWith(join(tmpdir(), "curator-research-state-")), "Cleanup must remain inside the test-owned temporary directory.");
  await rm(root, { recursive: true, force: true });
}
console.log(`Passed ${checks} research-state checks.`);
