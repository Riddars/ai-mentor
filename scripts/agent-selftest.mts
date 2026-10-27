/**
 * Free checks of the agent review: archive extraction, read-only tools, the agent loop on
 * pi's scripted provider and the finding verification on a stub model. No network, no keys.
 *
 *   npx tsx scripts/agent-selftest.mts
 *
 * BENCH_DIR points at a checkout of RiddarsCorp/curator-bench (default: ../curator-bench).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { runAgent } from "@/lib/agent/agent.mjs";
import { childEnv, removeStaleAgentDirs, runAgentProcess } from "@/lib/agent/run";
import { createToolLog, createTools } from "@/lib/agent/tools.mjs";
import { transcript } from "@/lib/agent/transcript.mjs";
import { extractTarball, listRepoFiles, relatedFiles, repoMap } from "@/lib/agent/workspace";
import { verifyFindings } from "@/lib/curator/verify";
import type { ReconcileResult } from "@/lib/curator/store";

const benchDir = resolve(process.env.BENCH_DIR ?? join(process.cwd(), "..", "curator-bench"));
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function rejects(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// --- archives --------------------------------------------------------------------------

type EntryType = "0" | "1" | "2" | "5";

function tarEntry(name: string, type: EntryType, content = "", linkname = ""): Buffer {
  const header = Buffer.alloc(512);
  const body = Buffer.from(content);
  header.write(name, 0, 100);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write(linkname, 157, 100);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function tarball(dir: string, entries: Buffer[]): string {
  const path = join(dir, `archive-${Math.random().toString(36).slice(2)}.tar.gz`);
  writeFileSync(path, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
  return path;
}

async function archiveChecks(work: string): Promise<void> {
  const dest = join(work, "unpacked", "repo");
  mkdirSync(dest, { recursive: true });
  const archive = tarball(work, [
    tarEntry("owner-repo-abc/", "5"),
    tarEntry("owner-repo-abc/src/ok.py", "0", "print('ok')\n"),
    tarEntry("owner-repo-abc/../evil.txt", "0", "escaped"),
    tarEntry("/etc/abs.txt", "0", "absolute"),
    tarEntry("owner-repo-abc/data", "2", "", "/home/student/datasets"),
    tarEntry("owner-repo-abc/passwd", "2", "", "/etc/passwd"),
    tarEntry("owner-repo-abc/hard", "1", "", "owner-repo-abc/src/ok.py"),
    tarEntry("owner-repo-abc/big.csv", "0", "x".repeat(300)),
  ]);
  const result = await extractTarball(archive, dest, {
    maxFileBytes: 200,
    maxTotalBytes: 10_000,
    maxFiles: 100,
    maxReadBytes: 1_000_000,
  });
  const files = (await listRepoFiles(dest)).map((f) => f.path);
  check("archive: regular file unpacked without the top directory", files.includes("src/ok.py"), files.join(", "));
  check("archive: '../' entry not written", !existsSync(join(work, "unpacked", "evil.txt")) && !existsSync(join(work, "evil.txt")));
  check("archive: only the regular file is on disk", files.length === 1, files.join(", "));
  const reasons = result.skipped.map((s) => `${s.path}: ${s.reason}`).join("; ");
  check("archive: symlinks recorded with their targets", reasons.includes("/etc/passwd") && reasons.includes("/home/student/datasets"), reasons);
  check("archive: hard link skipped", result.skipped.some((s) => s.path === "hard"), reasons);
  check("archive: oversized file skipped", result.skipped.some((s) => s.path === "big.csv"), reasons);

  const many = tarball(work, [
    tarEntry("r/", "5"),
    ...Array.from({ length: 10 }, (_, i) => tarEntry(`r/f${i}.txt`, "0", "x")),
  ]);
  const dest2 = join(work, "many");
  mkdirSync(dest2);
  const stopped = await extractTarball(many, dest2, { maxFileBytes: 100, maxTotalBytes: 10_000, maxFiles: 3, maxReadBytes: 1_000_000 });
  check("archive: file count limit stops extraction", stopped.stoppedOn !== null, String(stopped.stoppedOn));
}

// --- tools -----------------------------------------------------------------------------

async function toolChecks(work: string): Promise<void> {
  const root = join(benchDir, "projects", "solubility");
  const log = createToolLog();
  const tools = Object.fromEntries(createTools(root, log).map((t) => [t.name, t]));
  const call = (name: string, args: Record<string, unknown>) => tools[name].execute("call", args as never);
  const textOf = (r: Awaited<ReturnType<typeof call>>) => r.content.map((c) => ("text" in c ? c.text : "")).join("");

  check("tools: exactly the four read-only tools", Object.keys(tools).sort().join(",") === "grep,list_files,read_file,table_info");
  const outside = await rejects(call("read_file", { path: "../../../../Windows/win.ini" }));
  check("tools: path outside the copy refused", outside !== null, String(outside));
  const absolute = await rejects(call("read_file", { path: "/etc/passwd" }));
  check("tools: absolute path is resolved inside the copy", absolute !== null, String(absolute));

  const notebook = textOf(await call("read_file", { path: "notebooks/eda.ipynb" }));
  check("tools: notebook read as cells", notebook.includes("# [code]") && !notebook.includes('"cell_type"'));
  const grep = textOf(await call("grep", { text: "never for model selection" }));
  check("tools: grep finds the holdout note", grep.includes("src/splits.py:"), grep.split("\n")[0]);

  const started = Date.now();
  const table = textOf(
    await createTools(join(benchDir, "projects", "des-density"), log)
      .find((t) => t.name === "table_info")!
      .execute("call", { path: "data/density_measurements.csv" } as never),
  );
  check("tools: table_info on 200k rows", table.includes("строк данных: 200000"), `${Date.now() - started} ms`);
  const head = textOf(
    await createTools(join(benchDir, "projects", "des-density"), log)
      .find((t) => t.name === "read_file")!
      .execute("call", { path: "data/density_measurements.csv", from: 1000, to: 1300 } as never),
  );
  check(
    "tools: read_file shows only the head of a data file",
    head.includes("\n20\t") && !head.includes("\n21\t") && !head.includes("\n1000\t"),
    head.split("\n").at(-1),
  );
  check("tools: viewed files logged", log.viewed.has("notebooks/eda.ipynb"));

  const linked = join(work, "linked");
  mkdirSync(linked);
  writeFileSync(join(work, "secret.txt"), "secret");
  try {
    symlinkSync(join(work, "secret.txt"), join(linked, "secret-link.txt"));
    const viaLink = await rejects(
      createTools(linked, createToolLog()).find((t) => t.name === "read_file")!.execute("call", { path: "secret-link.txt" } as never),
    );
    check("tools: symlink leading outside refused", viaLink !== null, String(viaLink));
  } catch {
    console.log("skip symlink check (no permission to create symlinks)");
  }

  const files = await listRepoFiles(root);
  const related = await relatedFiles(root, ["src/train.py"], files);
  check("workspace: imports of the changed file found", related.includes("src/splits.py"), related.join(", "));
}

// --- agent loop ------------------------------------------------------------------------

const FINAL_JSON = JSON.stringify({ summary: "ok", findings: [] });

async function agentChecks(): Promise<void> {
  const root = join(benchDir, "projects", "solubility");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let replayedThinking = false;
  faux.setResponses([
    fauxAssistantMessage([fauxThinking("look at the split"), fauxToolCall("read_file", { path: "src/splits.py" })], {
      stopReason: "toolUse",
    }),
    (context) => {
      replayedThinking = context.messages.some(
        (m) => m.role === "assistant" && m.content.some((p) => p.type === "thinking"),
      );
      return fauxAssistantMessage(fauxText(FINAL_JSON));
    },
  ]);
  const result = await runAgent({ root, systemPrompt: "review", userPrompt: "go", models, model: faux.getModel() });
  check("agent: final answer returned", result.text === FINAL_JSON && result.error === null, String(result.error));
  check("agent: tool was used", result.log.viewed.has("src/splits.py"));
  check("agent: reasoning not sent back to the model", !replayedThinking);
  const log = transcript("case", result.messages, ["note"]);
  check(
    "transcript: shows request, tool call, tool result and answer",
    ["## Запрос", "→ `read_file`", "← `read_file`", "src/splits.py", FINAL_JSON, "- note"].every((s) => log.includes(s)),
  );

  faux.setResponses(
    Array.from({ length: 12 }, () => fauxAssistantMessage(fauxToolCall("list_files", {}), { stopReason: "toolUse" })),
  );
  const limited = await runAgent({
    root,
    systemPrompt: "review",
    userPrompt: "go",
    models,
    model: faux.getModel(),
    limits: { maxToolCalls: 2, maxTokens: 1_000_000, timeoutMs: 60_000 },
  });
  check("agent: tool call limit stops a looping model", limited.error !== null && limited.text === "", String(limited.error));

  faux.setResponses(
    Array.from({ length: 12 }, () => fauxAssistantMessage(fauxToolCall("read_file", { path: "src/train.py" }), { stopReason: "toolUse" })),
  );
  const budget = await runAgent({
    root,
    systemPrompt: "review",
    userPrompt: "go",
    models,
    model: faux.getModel(),
    limits: { maxToolCalls: 100, maxTokens: 2_000, timeoutMs: 60_000 },
  });
  check("agent: token budget stops the run", budget.error?.includes("token budget") === true, String(budget.error));

  const controller = new AbortController();
  controller.abort();
  faux.setResponses([fauxAssistantMessage(fauxText(FINAL_JSON))]);
  const cancelled = await runAgent({
    root,
    systemPrompt: "review",
    userPrompt: "go",
    models,
    model: faux.getModel(),
    signal: controller.signal,
  });
  check("agent: cancelled run reports an error", cancelled.error !== null, String(cancelled.error));
}

// --- agent process ---------------------------------------------------------------------

async function processChecks(work: string): Promise<void> {
  const archive = tarball(work, [
    tarEntry("o-r-sha/", "5"),
    tarEntry("o-r-sha/RESEARCH.md", "0", "# Research\n"),
    tarEntry("o-r-sha/link", "2", "", "/etc/passwd"),
  ]);
  const root = join(work, "process-repo");
  const started = Date.now();
  const reply = await runAgentProcess(
    {
      type: "run",
      tarPath: archive,
      root,
      systemPrompt: "review",
      userPrompt: "go",
      changed: [],
      // Nothing listens on this port: the agent must fail cleanly, not hang.
      model: { baseUrl: "http://127.0.0.1:9/v1", model: "none" },
      limits: { maxToolCalls: 5, maxTokens: 10_000, timeoutMs: 30_000 },
    },
    "test-key",
  );
  check("process: started, unpacked and replied over IPC", existsSync(join(root, "RESEARCH.md")), `${Date.now() - started} ms`);
  check("process: link recorded as not unpacked", reply.skipped.some((s) => s.path === "link"));
  check("process: model failure reported as an error", reply.error !== null && reply.text === "", String(reply.error));
  const onCopy = await runAgentProcess(
    {
      type: "run",
      root,
      systemPrompt: "verify",
      userPrompt: "go",
      changed: [],
      model: { baseUrl: "http://127.0.0.1:9/v1", model: "none" },
      limits: { maxToolCalls: 5, maxTokens: 10_000, timeoutMs: 30_000 },
    },
    "test-key",
  );
  check(
    "process: runs over a copy already on disk",
    onCopy.error !== null && onCopy.skipped.length === 0 && existsSync(join(root, "RESEARCH.md")),
    String(onCopy.error),
  );

  process.env.GITHUB_WEBHOOK_SECRET ??= "service-secret";
  const env = childEnv("model-key");
  const leaked = Object.keys(env).filter((k) => /GITHUB|SECRET|PASSWORD|TOKEN|PRIVATE|AUTH|SELECTEL|PROVOD|OPENAI/i.test(k));
  check("process: environment holds the model key and no service secrets", env.AGENT_API_KEY === "model-key" && leaked.length === 0, leaked.join(", "));
}

// --- verification ----------------------------------------------------------------------

async function verifyChecks(): Promise<void> {
  const root = join(benchDir, "projects", "solubility");
  const finding = (title: string, target: string, detail: string) => ({
    priorId: null,
    status: "open" as const,
    area: "methodology" as const,
    severity: "critical" as const,
    title,
    description: title,
    locations: [{ kind: "file" as const, target, detail }],
  });
  const result: ReconcileResult = {
    summary: "",
    findings: [
      finding("made-up file", "src/nowhere.py", "3"),
      finding("line beyond the end", "src/config.py", "900"),
      finding("real but rejected", "src/splits.py", "17-22"),
      finding("real and kept", "src/train.py", "20-24"),
      { priorId: 7, status: "closed", title: "prior finding untouched" },
    ],
  };
  let seen = "";
  const outcome = await verifyFindings(result, root, async (messages) => {
    seen = messages[1].content;
    return { content: JSON.stringify({ verdicts: [{ index: 0, keep: false, reason: "no" }, { index: 1, keep: true }] }), provider: "stub", model: "stub", usage: { input: 100, output: 10 } };
  });
  const titles = outcome.result.findings.map((f) => f.title);
  check("verify: citations that lead nowhere dropped", !titles.includes("made-up file") && !titles.includes("line beyond the end"));
  check("verify: model verdict applied", !titles.includes("real but rejected") && titles.includes("real and kept"), titles.join(", "));
  check("verify: tokens of the model check reported", outcome.tokens.input === 100 && outcome.tokens.output === 10);
  check("verify: prior findings not touched", titles.includes("prior finding untouched"));
  check("verify: model sees the real cited lines", seen.includes("def scaffold_split") && seen.includes("RESEARCH.md"));

  const failed = await verifyFindings(result, root, async () => {
    throw new Error("down");
  });
  check(
    "verify: findings kept when the check fails",
    !failed.checked && failed.result.findings.some((f) => f.title === "real but rejected"),
  );
}

// --- hostile repository content ---------------------------------------------------------

async function hardeningChecks(work: string): Promise<void> {
  const repo = join(work, "hostile");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "b.py"), "X = 1\n");
  writeFileSync(join(repo, "src", "a.py"), `${"\n".repeat(200_000)}x = 1\nimport src.b\n`);
  writeFileSync(join(repo, "src", "big.py"), `import src.b\n${"#".repeat(2 * 1024 * 1024)}\n`);
  const files = await listRepoFiles(repo);
  const started = Date.now();
  const related = await relatedFiles(repo, ["src/a.py"], files);
  const elapsed = Date.now() - started;
  check("hostile: import scan is linear on blank lines", related.includes("src/b.py") && elapsed < 2_000, `${elapsed} ms`);
  check("hostile: oversized changed source not scanned", (await relatedFiles(repo, ["src/big.py"], files)).length === 0);

  const map = repoMap([{ path: "a/".repeat(3_000), size: 1 }], { skipped: [], stoppedOn: null });
  check("hostile: long paths shortened in the map", map.length < 400, `${map.length} chars`);

  const links = tarball(work, [
    tarEntry("r/", "5"),
    ...Array.from({ length: 250 }, (_, i) => tarEntry(`r/l${i}`, "2", "", "/etc/passwd")),
  ]);
  const linksDest = join(work, "links");
  mkdirSync(linksDest);
  const linksResult = await extractTarball(links, linksDest);
  check(
    "hostile: list of skipped entries is bounded",
    linksResult.skipped.length === 201 && linksResult.skipped.at(-1)!.reason.includes("50 more"),
    `${linksResult.skipped.length} entries`,
  );

  const header = Array.from({ length: 5_000 }, (_, i) => `column_${i}_${"x".repeat(200)}`).join(",");
  writeFileSync(join(repo, "wide.csv"), `${header}\n${"1,".repeat(4_999)}1\n`);
  const names = Array.from({ length: 600 }, (_, i) => `${String(i).padStart(4, "0")}_${"n".repeat(120)}.txt`);
  mkdirSync(join(repo, "many"));
  for (const name of names) writeFileSync(join(repo, "many", name), "");
  const tools = Object.fromEntries(createTools(repo, createToolLog()).map((t) => [t.name, t]));
  const call = (name: string, args: Record<string, unknown>) => tools[name].execute("call", args as never);
  const textOf = (r: Awaited<ReturnType<typeof call>>) => r.content.map((c) => ("text" in c ? c.text : "")).join("");
  const wide = textOf(await call("table_info", { path: "wide.csv" }));
  check("hostile: table_info bounds a huge header", wide.length < 45_000 && wide.includes("… ещё 4900"), `${wide.length} chars`);
  const listing = textOf(await call("list_files", { dir: "many" }));
  check("hostile: tool output capped", listing.length <= 40_100 && listing.includes("вывод обрезан"), `${listing.length} chars`);
  const dirError = (await rejects(call("read_file", { path: "many" }))) ?? "";
  check("hostile: file system errors do not reveal host paths", dirError !== "" && !dirError.includes(work), dirError);

  writeFileSync(join(repo, "src", "min.py"), `${"y".repeat(100_000)}\n`);
  let seen = "";
  await verifyFindings(
    {
      summary: "",
      findings: [
        {
          priorId: null,
          status: "open",
          area: "code",
          severity: "important",
          title: "minified",
          description: "minified",
          locations: [{ kind: "file", target: "src/min.py", detail: "1" }],
        },
      ],
    },
    repo,
    async (messages) => {
      seen = messages[1].content;
      return { content: '{"verdicts": []}', provider: "stub", model: "stub", usage: { input: 1, output: 1 } };
    },
  );
  check("hostile: verification clips long cited lines", seen.length < 20_000, `${seen.length} chars`);

  const stale = join(tmpdir(), `curator-agent-selftest-${Date.now()}`);
  const fresh = `${stale}-fresh`;
  mkdirSync(stale);
  mkdirSync(fresh);
  const old = new Date(Date.now() - 24 * 60 * 60_000);
  utimesSync(stale, old, old);
  await removeStaleAgentDirs();
  check("process: stale repository copies removed, fresh ones kept", !existsSync(stale) && existsSync(fresh));
  rmSync(fresh, { recursive: true, force: true });
}

async function main() {
  if (!existsSync(join(benchDir, "projects"))) throw new Error(`curator-bench not found at ${benchDir}`);
  const work = mkdtempSync(join(tmpdir(), "agent-selftest-"));
  try {
    await archiveChecks(work);
    await toolChecks(work);
    await agentChecks();
    await processChecks(work);
    await verifyChecks();
    await hardeningChecks(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
