import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { pathContentExclusion, snapshotExclusion } from "@/lib/curator/snapshot-policy";
import { notebookCells } from "@/lib/curator/notebook";
import { formatSize } from "@/lib/agent/workspace";
import { jsonGet, jsonInfo, xmlGet, xmlInfo } from "@/lib/agent/structured.mjs";
import {
  addEvidenceRead, createResearchState, evidenceKey, findEvidenceRead, finishResearch, saveResearchNotes,
  type EvidenceInput, type ResearchState,
} from "@/lib/agent/research";

// Read-only tools over the repository copy. Every path goes through one check: the real
// path, after resolving links, must lie inside the copy. Outputs are bounded so a huge file
// cannot flood the model's context.

const MAX_LINES = 400;
const MAX_LINE_CHARS = 500;
const MAX_OUTPUT_CHARS = 40_000;
const MAX_LIST_ENTRIES = 500;
const MAX_GREP_MATCHES = 20;
const MAX_GREP_LINE_CHARS = 160;
const OUTPUT_BUDGET_CHARS = 120_000;
const RESERVED_EVIDENCE_CHARS = 8_000;
const MAX_GREP_FILE_BYTES = 5 * 1024 * 1024;
const MAX_NOTEBOOK_BYTES = 20 * 1024 * 1024;

/** What the agent looked at: shown in the review and used to check its claims. */
export interface ToolLog {
  calls: Array<{ tool: string; args: unknown; error?: string }>;
  complete?: boolean;
  notes?: string;
  evidence?: Map<string, string>;
  outputExhausted?: boolean;
  research?: ResearchState;
  viewed: Set<string>;
}

export function createToolLog(): ToolLog {
  return { calls: [], viewed: new Set() };
}

async function resolveInside(root: string, path: string): Promise<{ full: string; rel: string }> {
  const realRoot = await realpath(root);
  let full: string;
  try {
    full = await realpath(resolve(realRoot, path.replace(/^\/+/, "")));
  } catch {
    throw new Error(`Not found: ${path}`);
  }
  if (full !== realRoot && !full.startsWith(realRoot + sep)) {
    throw new Error(`Path is outside the repository: ${path}`);
  }
  const rel = relative(realRoot, full).split(sep).join("/");
  const excluded = pathContentExclusion(rel);
  if (excluded) throw new Error(`File content excluded by policy: ${excluded}`);
  return { full, rel };
}

async function resolveReviewableFile(root: string, path: string) {
  const resolved = await resolveInside(root, path);
  const excluded = snapshotExclusion(path) ?? snapshotExclusion(resolved.rel);
  if (excluded) throw new Error(`File content excluded by policy: ${excluded}`);
  return resolved;
}

async function isBinary(full: string): Promise<boolean> {
  const handle = await open(full, "r");
  try {
    const buffer = Buffer.alloc(8000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function clip(line: string, max = MAX_LINE_CHARS): string {
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function matchExcerpt(line: string, needle: string): string {
  const index = line.toLowerCase().indexOf(needle);
  if (index < 0 || line.length <= MAX_GREP_LINE_CHARS) return line;
  const start = Math.max(0, index - 60);
  const end = Math.min(line.length, Math.max(index + needle.length + 40, start + MAX_GREP_LINE_CHARS));
  return `${start ? "…" : ""}${line.slice(start, Math.min(end, start + MAX_GREP_LINE_CHARS))}${end < line.length ? "…" : ""}`;
}

function isNotebook(path: string): boolean {
  return path.toLowerCase().endsWith(".ipynb");
}

/** Text lines of a file as the agent sees it: notebooks as their cells, other files as is. */
async function textLines(full: string, rel: string): Promise<string[]> {
  if (isNotebook(rel)) {
    if ((await stat(full)).size > MAX_NOTEBOOK_BYTES) throw new Error(`Notebook is too large to read: ${rel}`);
    const cells = notebookCells(await readFile(full, "utf8"));
    if (cells === null) throw new Error(`Not a valid notebook: ${rel}`);
    return cells.split("\n");
  }
  if (await isBinary(full)) throw new Error(`Binary file, cannot be read as text: ${rel}`);
  return (await readFile(full, "utf8")).split(/\r?\n/);
}

/** Lines `from`..`to` of a large text file, read as a stream. */
async function streamLines(full: string, from: number, to: number): Promise<{ lines: string[]; total: number }> {
  const lines: string[] = [];
  let n = 0;
  const reader = createInterface({ input: createReadStream(full, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of reader) {
    n += 1;
    if (n >= from && n <= to) lines.push(line);
  }
  return { lines, total: n };
}

function numbered(lines: string[], from: number): string {
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const line = `${from + i}\t${clip(lines[i])}\n`;
    if (out.length + line.length > MAX_OUTPUT_CHARS) {
      return `${out}… (вывод обрезан на строке ${from + i - 1})`;
    }
    out += line;
  }
  return out.trimEnd();
}

function text(value: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: value }], details: undefined };
}

/** File system errors carry host paths; the model gets a neutral message instead. */
function neutralError(error: unknown, path: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return error instanceof Error ? error : new Error(String(error));
  return new Error(`Cannot read ${typeof path === "string" && path ? clip(path, 200) : "this path"} (${code})`);
}

const listParams = Type.Object({
  dir: Type.Optional(Type.String({ description: "Directory relative to the repository root; empty for the root" })),
  reason: Type.Optional(Type.String({ minLength: 8, maxLength: 500 })),
});
const readParams = Type.Object({
  path: Type.String({ description: "File path relative to the repository root" }),
  from: Type.Optional(Type.Integer({ minimum: 1, description: "First line, 1-based" })),
  to: Type.Optional(Type.Integer({ minimum: 1, description: "Last line, inclusive" })),
  reason: Type.Optional(Type.String({ minLength: 8, maxLength: 500, description: "Concrete reason to reread an already returned range (restores full output instead of a cached reference)" })),
});
const grepParams = Type.Object({
  text: Type.String({ minLength: 2, description: "Plain text to search for (not a regular expression), case-insensitive" }),
  path: Type.Optional(Type.String({ description: "Limit the search to this directory or file" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Number of matches to skip for the next page" })),
  reason: Type.Optional(Type.String({ minLength: 8, maxLength: 500 })),
});
const tableParams = Type.Object({
  path: Type.String({ description: "Reviewable file relative to the repository root" }),
  reason: Type.Optional(Type.String({ minLength: 8, maxLength: 500, description: "Concrete reason to restore an already returned result" })),
});
const jsonGetParams = Type.Object({
  path: Type.String({ description: "JSON file relative to the repository root" }),
  key: Type.String({ description: "Concrete JSON path, e.g. /runs/17/metrics; JSON Pointer escapes: ~0 for ~, ~1 for /" }),
  reason: Type.Optional(Type.String({ minLength: 8, maxLength: 500 })),
});
const xmlGetParams = Type.Object({
  path: Type.String({ description: "XML file relative to the repository root" }),
  element: Type.String({ description: "Element path, e.g. report/run" }),
  index: Type.Integer({ minimum: 0, description: "Zero-based occurrence of that element" }),
  reason: Type.Optional(Type.String({ minLength: 8, maxLength: 500 })),
});
export interface ToolOutputLimits {
  /** Initial shared allowance; defaults to 300k overview / 120k PR characters. */
  maxOutputChars?: number;
  /** Optional live allowance owned by the execution budget. */
  remainingOutputChars?: () => number;
}

export function createTools(root: string, log: ToolLog, overview = false, outputLimit: number | ToolOutputLimits = {}): AgentTool[] {
  let outputChars = 0;
  const outputOptions = typeof outputLimit === "number" ? { maxOutputChars: outputLimit } : outputLimit;
  const maxOutputChars = outputOptions.maxOutputChars ?? (overview ? 300_000 : OUTPUT_BUDGET_CHARS);
  if (!Number.isFinite(maxOutputChars) || maxOutputChars < 0) throw new Error("Tool output allowance must be finite and nonnegative.");
  const remainingOutput = () => {
    const external = outputOptions.remainingOutputChars?.() ?? Infinity;
    return Math.max(0, Math.floor(Math.min(maxOutputChars - outputChars, Number.isNaN(external) ? 0 : external)));
  };
  const boundedText = (value: string, allowance: number): string => {
    if (value.length <= allowance) return value;
    const marker = "\n… (вывод обрезан)";
    return allowance <= marker.length ? value.slice(0, allowance) : value.slice(0, allowance - marker.length) + marker;
  };
  // Every successful tool response, including cached references and status messages,
  // spends this same allowance. No post-ledger wrapper may silently trim a reading.
  const deliver = (value: string): AgentToolResult<undefined> => {
    const remaining = remainingOutput();
    const bounded = boundedText(value, Math.min(MAX_OUTPUT_CHARS, remaining));
    outputChars += bounded.length;
    if (remaining <= value.length || remainingOutput() === 0) log.outputExhausted = true;
    return text(bounded);
  };
  if (overview) {
    log.evidence ??= new Map();
    log.research ??= createResearchState();
  }
  const research = overview ? log.research : undefined;
  type ReadDetails = Omit<EvidenceInput, "content" | "truncated"> & { truncated?: boolean; reason?: string };
  const emit = (value: string, evidence = false, viewedPath?: string, reading?: ReadDetails): AgentToolResult<undefined> => {
    if (reading?.reason !== undefined && reading.reason.trim().length < 8) throw new Error("Give a concrete reread reason (at least 8 characters).");
    const remaining = remainingOutput();
    if (remaining < (research && reading ? 512 : 1)) {
      log.outputExhausted = true;
      return deliver("Лимит текста инструментов почти исчерпан. Заверши разбор по уже полученным материалам; новое основание не зарегистрировано.");
    }
    const previous = research && reading ? findEvidenceRead(research, reading) : undefined;
    if (previous && !reading?.reason) {
      return deliver(`Уже прочитано: [${previous.id}] ${previous.path}${previous.from === undefined ? "" : `:${previous.from}–${previous.to}`}` +
        `${previous.selector ? ` (${previous.selector})` : ""}. Повтор не добавляет новых оснований. ` +
        "Если нужен исходный текст для проверки или он отсутствует в контексте, повтори вызов с reason — конкретной причиной перечитывания.");
    }
    const overhead = research && reading ? 512 : 0;
    const reserve = !overview && !evidence ? RESERVED_EVIDENCE_CHARS : 0;
    const available = Math.max(0, Math.min(MAX_OUTPUT_CHARS - overhead, remaining - overhead - reserve));
    if (available === 0) {
      log.outputExhausted = true;
      return deliver("Лимит текста инструментов достигнут. Заверши разбор по уже полученным материалам.");
    }
    const bounded = boundedText(value, available);
    let outgoing = bounded;
    if (research && reading) {
      const metadata = { ...reading };
      delete metadata.reason;
      metadata.requestKey ??= evidenceKey(reading);
      const content = bounded;
      const lineNumbers = [...content.matchAll(/^(\d+)\t/gm)].map(match => Number(match[1]));
      const ranges: Array<{ from: number; to: number }> = [];
      for (const number of lineNumbers) {
        const last = ranges.at(-1);
        if (last && number === last.to + 1) last.to = number;
        else if (!last || number > last.to) ranges.push({ from: number, to: number });
      }
      // Never retain an unreturned requested suffix as if the model had seen it.
      if (metadata.from !== undefined) {
        if (ranges.length === 0) return deliver(bounded);
        metadata.from = ranges[0].from;
        metadata.to = ranges.at(-1)!.to;
      }
      if (metadata.kind === "log_preview") metadata.ranges = ranges;
      const read = addEvidenceRead(research, {
        ...metadata, content,
        truncated: Boolean(metadata.truncated || bounded.length < value.length || /… \(вывод обрезан/.test(content)),
      });
      research.complete = false;
      log.complete = false;
      outgoing = `[${read.id}] Основание: ${read.kind}${read.from === undefined ? "" : `, строки ${read.from}–${read.to}`}\n${bounded}`;
      if (read.to !== undefined && read.totalLines !== undefined && read.to < read.totalLines && read.kind !== "data_preview") {
        outgoing += `\nСледующий диапазон: from=${read.to + 1}, to=${Math.min(read.totalLines, read.to + (overview ? 80 : MAX_LINES))}.`;
      }
    }
    const result = deliver(outgoing);
    if (viewedPath) {
      log.viewed.add(viewedPath);
      const excerpt = result.content[0];
      if (excerpt?.type === "text" && log.evidence && (evidence || !log.evidence.has(viewedPath))) {
        log.evidence.set(viewedPath, excerpt.text.slice(0, 900));
      }
    }
    return result;
  };
  const record = <T,>(tool: string, args: unknown, run: () => Promise<T>): Promise<T> =>
    run().then(
      (result) => {
        log.calls.push({ tool, args });
        return result;
      },
      (error: unknown) => {
        const { path, dir } = args as { path?: unknown; dir?: unknown };
        const neutral = neutralError(error, path ?? dir);
        log.calls.push({ tool, args, error: neutral.message });
        throw neutral;
      },
    );

  const listFiles: AgentTool<typeof listParams> = {
    name: "list_files",
    label: "List files",
    description: "List the entries of a repository directory with file sizes (not recursive).",
    parameters: listParams,
    execute: (_id, { dir, reason }) =>
      record("list_files", { dir, reason }, async () => {
        const { full, rel } = await resolveInside(root, dir ?? "");
        const entries = await readdir(full, { withFileTypes: true });
        const lines: string[] = [];
        for (const entry of entries.slice(0, MAX_LIST_ENTRIES)) {
          const path = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) lines.push(`${path}/`);
          else if (entry.isFile()) lines.push(`${path} (${formatSize((await stat(join(full, entry.name))).size)})`);
        }
        if (entries.length > MAX_LIST_ENTRIES) lines.push(`… ещё ${entries.length - MAX_LIST_ENTRIES} записей`);
        return emit(lines.sort().join("\n") || "(пусто)", false, undefined,
          { path: rel || ".", kind: "listing", truncated: entries.length > MAX_LIST_ENTRIES, reason });
      }),
  };

  const readFileTool: AgentTool<typeof readParams> = {
    name: "read_file",
    label: "Read file",
    description:
      `Read a text file with line numbers; defaults to ${overview ? 80 : MAX_LINES} lines, at most ${MAX_LINES} per call. Use the returned next range for longer files. ` +
      "Notebooks are shown as their code and markdown cells; line numbers refer to that view. " +
      "Only files allowed by the review policy can be read. " +
      "Overview results have evidence IDs. An identical read returns a reference; provide reason to restore its text.",
    parameters: readParams,
    execute: (_id, { path, from, to, reason }) =>
      record("read_file", { path, from, to, reason }, async () => {
        if (from !== undefined && to !== undefined && to < from) throw new Error("Last line must not precede the first line.");
        const { full, rel } = await resolveReviewableFile(root, path);
        const size = (await stat(full)).size;
        if (size > MAX_OUTPUT_CHARS && /\.json$/i.test(rel)) return emit(`${rel}\n${await jsonInfo(full)}\nДля точного значения используй json_get.`, false, rel, { path: rel, kind: "json_summary", truncated: true, reason });
        if (size > MAX_OUTPUT_CHARS && /\.xml$/i.test(rel)) return emit(`${rel}\n${await xmlInfo(full)}`, false, rel, { path: rel, kind: "xml_summary", truncated: true, reason });
        const start = from ?? 1;
        const last = start + MAX_LINES - 1;
        const end = Math.min(to ?? (overview ? start + 79 : last), last);
        let lines: string[];
        let total: number;
        if (!isNotebook(rel) && (await stat(full)).size > MAX_GREP_FILE_BYTES) {
          if (await isBinary(full)) throw new Error(`Binary file, cannot be read as text: ${rel}`);
          ({ lines, total } = await streamLines(full, start, end));
        } else {
          const all = await textLines(full, rel);
          lines = all.slice(start - 1, end);
          total = all.length;
        }
        const rendered = numbered(lines, start);
        const shownEnd = Number([...rendered.matchAll(/^(\d+)\t/gm)].at(-1)?.[1] ?? start - 1);
        const tail =
          shownEnd < total
            ? `\n… (всего строк: ${total}${!overview ? `; следующий диапазон: from=${shownEnd + 1}, to=${Math.min(total, shownEnd + MAX_LINES)}` : ""})`
            : "";
        return emit(`${rel}\n${rendered}${tail}`, from !== undefined && to !== undefined && to - from < 20, rel,
          { path: rel, kind: isNotebook(rel) ? "notebook" : "text", from: start, to: start + lines.length - 1,
            totalLines: total, truncated: start > 1 || start + lines.length - 1 < total || lines.some(line => line.length > MAX_LINE_CHARS), reason });
      }),
  };

  const grep: AgentTool<typeof grepParams> = {
    name: "grep",
    label: "Search",
    description:
      `Find text in repository files, ${MAX_GREP_MATCHES} short matches per page; use offset for later pages. ` +
      "Only files allowed by the review policy are searched. Notebooks use their cells view.",
    parameters: grepParams,
    execute: (_id, { text: needle, path, offset, reason }) =>
      record("grep", { text: needle, path, offset, reason }, async () => {
        const { full: base, rel: baseRel } = await resolveInside(root, path ?? "");
        if ((await stat(base)).isFile()) await resolveReviewableFile(root, path ?? "");
        const target = needle.toLowerCase();
        const matches: string[] = [];
        let total = 0;
        const pageEnd = (offset ?? 0) + MAX_GREP_MATCHES;
        let hasMore = false;
        let skipped = 0;
        const visit = async (full: string, rel: string): Promise<void> => {
          if (hasMore) return;
          if (pathContentExclusion(rel)) { skipped += 1; return; }
          const info = await lstat(full);
          if (info.isDirectory()) {
            for (const entry of await readdir(full)) {
              await visit(join(full, entry), rel ? `${rel}/${entry}` : entry);
            }
            return;
          }
          if (!info.isFile()) return;
          if (snapshotExclusion(rel)) { skipped += 1; return; }
          if (info.size > MAX_OUTPUT_CHARS && /\.(?:json|xml)$/i.test(rel)) { skipped += 1; return; }
          if (info.size > MAX_GREP_FILE_BYTES && !isNotebook(rel)) {
            skipped += 1;
            return;
          }
          let lines: string[];
          try {
            lines = await textLines(full, rel);
          } catch {
            return;
          }
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(target)) {
              if (total >= pageEnd) { hasMore = true; return; }
              if (total >= (offset ?? 0) && matches.length < MAX_GREP_MATCHES) matches.push(`${rel}:${i + 1}: ${matchExcerpt(lines[i].trim(), target)}`);
              total += 1;
            }
          }
        };
        await visit(base, baseRel);
        const notes = [
          `${hasMore ? `найдено более ${total}` : `всего совпадений: ${total}`}; показаны ${matches.length ? (offset ?? 0) + 1 : 0}–${Math.min(total, (offset ?? 0) + matches.length)}${hasMore ? `; следующая порция: offset=${(offset ?? 0) + matches.length}` : ""}`,
          skipped > 0 ? `пропущено файлов данных, журналов или крупных файлов: ${skipped}` : "",
        ].filter(Boolean);
        return emit([matches.join("\n") || "Совпадений нет.", ...notes.map((n) => `(${n})`)].join("\n"), false, undefined,
          { path: baseRel || ".", kind: "search", selector: JSON.stringify({ text: needle.toLowerCase(), offset: offset ?? 0 }), truncated: hasMore || skipped > 0, reason });
      }),
  };

  const jsonInfoTool: AgentTool<typeof tableParams> = {
    name: "json_info", label: "JSON structure",
    description: "Summarize a JSON file without sending all records: array counts and small samples.",
    parameters: tableParams,
    execute: (_id, { path, reason }) => record("json_info", { path, reason }, async () => {
      const { full, rel } = await resolveReviewableFile(root, path);
      if (!/\.json$/i.test(rel)) throw new Error(`Not a reviewable JSON file: ${rel}`);
      return emit(`${rel}\n${await jsonInfo(full)}`, false, rel, { path: rel, kind: "json_summary", truncated: true, reason });
    }),
  };
  const jsonGetTool: AgentTool<typeof jsonGetParams> = {
    name: "json_get", label: "JSON value",
    description: "Read one concrete JSON path with a bounded result, e.g. /runs/17/metrics.",
    parameters: jsonGetParams,
    execute: (_id, { path, key, reason }) => record("json_get", { path, key, reason }, async () => {
      const { full, rel } = await resolveReviewableFile(root, path);
      if (!/\.json$/i.test(rel)) throw new Error(`Not a reviewable JSON file: ${rel}`);
      return emit(`${rel}\n${await jsonGet(full, key)}`, true, rel, { path: rel, kind: "json_value", selector: key, reason });
    }),
  };
  const xmlInfoTool: AgentTool<typeof tableParams> = {
    name: "xml_info", label: "XML structure",
    description: "Count XML elements and list their attributes without showing the full file.",
    parameters: tableParams,
    execute: (_id, { path, reason }) => record("xml_info", { path, reason }, async () => {
      const { full, rel } = await resolveReviewableFile(root, path);
      if (!/\.xml$/i.test(rel)) throw new Error(`Not an XML file: ${rel}`);
      return emit(`${rel}\n${await xmlInfo(full)}`, false, rel, { path: rel, kind: "xml_summary", truncated: true, reason });
    }),
  };
  const xmlGetTool: AgentTool<typeof xmlGetParams> = {
    name: "xml_get", label: "XML element",
    description: "Read one bounded XML element by path and occurrence index.", parameters: xmlGetParams,
    execute: (_id, { path, element, index, reason }) => record("xml_get", { path, element, index, reason }, async () => {
      const { full, rel } = await resolveReviewableFile(root, path);
      if (!/\.xml$/i.test(rel)) throw new Error(`Not an XML file: ${rel}`);
      return emit(`${rel}\n${await xmlGet(full, element, index)}`, true, rel, { path: rel, kind: "xml_element", selector: `${element}[${index}]`, reason });
    }),
  };
  const questionParams = Type.Object({
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Existing question ID to update; omit for a new question" })),
    question: Type.String({ minLength: 10, maxLength: 1000 }),
    status: Type.Union([Type.Literal("pending"), Type.Literal("checked"), Type.Literal("blocked"), Type.Literal("not_applicable")]),
    evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 30, description: "Real evidence IDs returned by reading tools, e.g. r1" })),
    rationale: Type.Optional(Type.String({ maxLength: 2000, description: "Concrete result or explanation; checked/not_applicable require at least 20 characters" })),
  });
  const noteParams = Type.Object({
    notes: Type.String({ minLength: 1, maxLength: 4000 }),
    questions: Type.Optional(Type.Array(questionParams, { maxItems: 30 })),
  });
  const saveNotes: AgentTool<typeof noteParams> = {
    name: "save_review_notes", label: "Save working notes", parameters: noteParams,
    description: "Replace authored working notes and optionally add/update adaptive main questions. Preserve existing questions unless updated by ID. Checked questions require real evidence IDs and a concrete rationale. No publication; notes are separate from automatic summaries.",
    execute: (_id, args) => record("save_review_notes", args, async () => {
      saveResearchNotes(log.research!, args.notes, args.questions);
      log.complete = log.research!.complete;
      return deliver(`Рабочие заметки сохранены отдельно от сводки. Вопросы: ${log.research!.questions.map(question => `${question.id}: ${question.status}`).join(", ") || "ещё не сформулированы"}.`);
    }),
  };
  const finishParams = Type.Object({
    checked: Type.String({minLength: 100, maxLength: 4000, description:"Main questions checked, with concrete files and evidence"}),
    unresolved: Type.Array(Type.String(), {maxItems:20, description:"Questions preventing a full overview; empty only when the review is complete"}),
  });
  const finishReview: AgentTool<typeof finishParams> = {
    name: "finish_overview", label: "Finish overview", parameters: finishParams,
    description: "Finish after at least two independent main questions are checked with concrete rationale and real evidence IDs. Different questions may share evidence in a small repository. Use save_review_notes to track questions. Pending/blocked questions prevent full completion. Exhaustive reading is unnecessary; list material gaps for an honest partial report.",
    execute: (_id, args) => record("finish_overview", args, async () => {
      const finished = finishResearch(log.research!, args.checked, args.unresolved);
      log.complete = finished.complete;
      if (finished.problems.length > 0) return deliver("Полный обзор пока не подтверждён:\n" + finished.problems.join("\n") + "\nОбнови вопросы и основания через save_review_notes или явно укажи пробелы unresolved.");
      log.outputExhausted = true;
      return deliver(finished.complete
        ? "Исследование завершено по проверенным вопросам. Следующим ответом верни итоговый JSON."
        : "Сохранён частичный результат с явными пробелами. Следующим ответом верни итоговый JSON по проверенным материалам.");
    }),
  };
  return [...(overview ? [saveNotes, finishReview] : []), listFiles, readFileTool, grep, jsonInfoTool, jsonGetTool, xmlInfoTool, xmlGetTool] as AgentTool[];
}
