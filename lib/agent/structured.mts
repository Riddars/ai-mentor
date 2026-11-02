import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { Tokenizer } from "@streamparser/json";
import { SaxesParser } from "saxes";
import { Parser as HtmlParser } from "htmlparser2";

const SAMPLE = 3;
const MAX_SAMPLE = 300;
const MAX_PATHS = 80;

function short(value: unknown, max = MAX_SAMPLE): string {
  const project = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return item.length > 200 ? `${item.slice(0, 200)}…` : item;
    if (depth >= 3) return Array.isArray(item) ? `[array: ${item.length}]` : item && typeof item === "object" ? `[object: ${Object.keys(item).length} keys]` : item;
    if (Array.isArray(item)) return { length: item.length, sample: item.slice(0, 3).map((entry) => project(entry, depth + 1)) };
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).slice(0, 8).map(([key, entry]) => [key, project(entry, depth + 1)]));
    return item;
  };
  const raw = JSON.stringify(project(value, 0));
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

async function feed(full: string, write: (chunk: Buffer) => void, end: () => void): Promise<void> {
  for await (const chunk of createReadStream(full)) write(chunk as Buffer);
  end();
}

/** Each root array member or second-level object member is assembled separately. */
export async function jsonInfo(full: string): Promise<string> {
  type Frame = { path: string; kind: "object" | "array"; key: string | null; expectingKey: boolean; count: number };
  const stack: Frame[] = [];
  const counts = new Map<string, number>();
  const samples = new Map<string, string[]>();
  let root = "unknown";
  const enter = (kind: "object" | "array", value?: unknown): string => {
    const parent = stack.at(-1);
    if (!parent) { root = kind; return "$"; }
    parent.count++;
    const path = parent.kind === "array" ? `${parent.path}[]` : `${parent.path}.${parent.key ?? "?"}`;
    if (parent.kind === "object") parent.key = null;
    if (value !== undefined) {
      const list = samples.get(parent.path) ?? [];
      if (list.length < SAMPLE) { list.push(short(value)); samples.set(parent.path, list); }
    }
    return path;
  };
  const parser = new Tokenizer({ stringBufferSize: 64 * 1024 });
  parser.onToken = ({ token, value }) => {
    if (token === 0 || token === 2) {
      const kind = token === 0 ? "object" : "array";
      const path = enter(kind);
      if (stack.length >= 64) throw new Error("JSON nesting is too deep");
      stack.push({ path, kind, key: null, expectingKey: kind === "object", count: 0 });
    } else if (token === 1 || token === 3) {
      const frame = stack.pop();
      if (frame && (!counts.has(frame.path) || counts.size < MAX_PATHS)) counts.set(frame.path, (counts.get(frame.path) ?? 0) + frame.count);
    } else if (token === 5) {
      const frame = stack.at(-1);
      if (frame?.kind === "object") frame.expectingKey = true;
    } else if (token === 9 && stack.at(-1)?.kind === "object" && stack.at(-1)?.expectingKey) {
      const frame = stack.at(-1)!;
      frame.key = String(value).slice(0, 80);
      frame.expectingKey = false;
    } else if (token === 9 || token === 10 || token === 6 || token === 7 || token === 8) {
      enter("object", value);
    }
  };
  await feed(full, (chunk) => parser.write(chunk), () => { if (!parser.isEnded) parser.end(); });
  const lines = [`JSON: ${(await stat(full)).size} байт; корень ${root === "array" ? "массив" : "объект"}`];
  for (const [path, count] of counts) lines.push(`${path}: ${count} элементов; примеры ${samples.get(path)?.join(" | ") ?? "—"}`);
  return lines.join("\n");
}

export async function jsonGet(full: string, path: string): Promise<string> {
  const target = path.startsWith("/")
    ? path.slice(1).split("/").map((part) => { if (/~(?![01])/.test(part)) throw new Error("Invalid JSON Pointer escape"); return part.replace(/~1/g, "/").replace(/~0/g, "~"); })
    : /^\$(?:\.[A-Za-z0-9_\-]+)+$/.test(path) ? path.slice(2).split(".") : null;
  if (!target || target.length > 64) throw new Error("Use a JSON Pointer like /runs/17/metrics (escape ~ as ~0, / as ~1)");
  type Frame = { parts: string[]; kind: "object" | "array"; key: string | null; expectingKey: boolean; count: number };
  const stack: Frame[] = [];
  let found = false;
  let result = "";
  const nextPath = (): string[] => {
    const parent = stack.at(-1);
    if (!parent) return [];
    const part = parent.kind === "array" ? String(parent.count) : parent.key ?? "?";
    parent.count++;
    if (parent.kind === "object") parent.key = null;
    return [...parent.parts, part];
  };
  const matches = (parts: string[]) => parts.length === target.length && parts.every((part, i) => part === target[i]);
  const inside = (parts: string[]) => parts.length > target.length && target.every((part, i) => part === parts[i]);
  const parser = new Tokenizer({ stringBufferSize: 64 * 1024 });
  parser.onToken = ({ token, value }) => {
    if (token === 0 || token === 2) {
      const itemPath = nextPath();
      if (stack.length >= 64) throw new Error("JSON nesting is too deep");
      const kind = token === 0 ? "object" : "array";
      stack.push({ parts: itemPath, kind, key: null, expectingKey: kind === "object", count: 0 });
      if (matches(itemPath)) { found = true; result = `${path}: ${kind}\n`; }
    } else if (token === 1 || token === 3) {
      const frame = stack.pop();
      if (frame && matches(frame.parts)) result += `элементов: ${frame.count}`;
    } else if (token === 5) {
      const frame = stack.at(-1);
      if (frame?.kind === "object") frame.expectingKey = true;
    } else if (token === 9 && stack.at(-1)?.kind === "object" && stack.at(-1)?.expectingKey) {
      const frame = stack.at(-1)!;
      frame.key = String(value);
      frame.expectingKey = false;
    } else if (token === 9 || token === 10 || token === 6 || token === 7 || token === 8) {
      const itemPath = nextPath();
      if (matches(itemPath)) { found = true; result = `${path}: ${short(value, 3_000)}`; }
      else if (inside(itemPath) && result.length < 3_000) result += `/${itemPath.map((part) => part.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}: ${short(value, 200)}\n`;
    }
  };
  await feed(full, (chunk) => parser.write(chunk), () => { if (!parser.isEnded) parser.end(); });
  return found ? result.slice(0, 3_000) : `${path}: не найден`;
}

export async function xmlInfo(full: string): Promise<string> {
  const counts = new Map<string, number>();
  const examples = new Map<string, string>();
  const stack: string[] = [];
  const parser = new SaxesParser();
  parser.on("opentag", (tag) => {
    stack.push(tag.name);
    if (stack.length > 64) throw new Error("XML nesting is too deep");
    const path = stack.slice(0, 4).join("/");
    if (!counts.has(path) && counts.size >= MAX_PATHS) return;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (!examples.has(path)) examples.set(path, Object.keys(tag.attributes).slice(0, 8).join(", "));
  });
  parser.on("closetag", () => { stack.pop(); });
  const decoder = new StringDecoder("utf8");
  await feed(full, (chunk) => parser.write(decoder.write(chunk)), () => { parser.write(decoder.end()); parser.close(); });
  return [`XML: ${(await stat(full)).size} байт`, ...[...counts].map(([p, n]) => `${p}: ${n} элементов; атрибуты ${examples.get(p) || "—"}`)].join("\n");
}

export async function xmlGet(full: string, requested: string, index: number): Promise<string> {
  if (!/^[A-Za-z][\w:.-]*(?:\/[A-Za-z][\w:.-]*){0,7}$/.test(requested) || index < 0) throw new Error("Use an element path like report/run and a nonnegative index");
  const parser = new SaxesParser();
  const decoder = new StringDecoder("utf8");
  const stack: string[] = [];
  let seen = 0;
  let activeDepth = -1;
  let result = "";
  parser.on("opentag", (tag) => {
    stack.push(tag.name);
    if (stack.length > 64) throw new Error("XML nesting is too deep");
    if (activeDepth > 0 && result.length < 3_000) result += `<${tag.name}>`;
    if (stack.join("/") === requested) {
      if (seen === index) {
        activeDepth = stack.length;
        result = `<${tag.name} ${Object.entries(tag.attributes).slice(0, 12).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}>`;
      }
      seen += 1;
    }
  });
  parser.on("text", (value) => { if (activeDepth > 0 && result.length < 3_000) result += value.slice(0, 3_000 - result.length); });
  parser.on("closetag", (tag) => {
    if (activeDepth > 0 && result.length < 3_000) result += `</${tag.name}>`;
    if (stack.length === activeDepth) activeDepth = -1;
    stack.pop();
  });
  await feed(full, (chunk) => parser.write(decoder.write(chunk)), () => { parser.write(decoder.end()); parser.close(); });
  return result ? `${requested}[${index}]: ${result.slice(0, 3_000)}` : `${requested}[${index}]: не найден`;
}

export async function htmlInfo(full: string): Promise<string> {
  let title = "";
  let inTitle = false;
  let hidden = 0;
  let tables = 0;
  let rows = 0;
  let links = 0;
  const headings: string[] = [];
  const text: string[] = [];
  let heading = "";
  let headingDepth = 0;
  let textChars = 0;
  const tableRows: string[] = [];
  let row: string[] = [];
  let cell = "";
  let inCell = false;
  const parser = new HtmlParser({
    onopentag(name) {
      if (name === "script" || name === "style") hidden += 1;
      if (name === "title") inTitle = true;
      if (/^h[1-6]$/.test(name)) { headingDepth += 1; heading = ""; }
      if (name === "table") tables += 1;
      if (name === "a") links += 1;
      if (name === "tr") { row = []; rows += 1; }
      if (name === "td" || name === "th") { inCell = true; cell = ""; }
    },
    ontext(value) {
      if (hidden) return;
      const clean = value.replace(/\s+/g, " ").trim();
      if (!clean) return;
      if (inTitle && title.length < 200) title += clean.slice(0, 200 - title.length);
      if (headingDepth && heading.length < 200) heading += clean.slice(0, 200 - heading.length);
      if (inCell && cell.length < 100) cell += clean.slice(0, 100 - cell.length);
      if (textChars < 1_500) { const piece = clean.slice(0, 200); text.push(piece); textChars += piece.length; }
    },
    onclosetag(name) {
      if (name === "script" || name === "style") hidden = Math.max(0, hidden - 1);
      if (name === "title") inTitle = false;
      if (/^h[1-6]$/.test(name)) { if (headings.length < 30) headings.push(heading); headingDepth = Math.max(0, headingDepth - 1); }
      if (name === "td" || name === "th") { inCell = false; if (row.length < 20) row.push(cell); }
      if (name === "tr" && row.length && tableRows.length < 5) tableRows.push(row.join(" | "));
    },
  }, { decodeEntities: true });
  const decoder = new StringDecoder("utf8");
  await feed(full, (chunk) => parser.write(decoder.write(chunk)), () => { parser.write(decoder.end()); parser.end(); });
  return `HTML: ${(await stat(full)).size} байт; заголовок: ${title || "—"}; таблиц: ${tables}; строк таблиц: ${rows}; ссылок: ${links}\nРазделы: ${headings.join(" | ") || "—"}\nПримеры строк: ${tableRows.join(" / ") || "—"}\nНачало видимого текста: ${text.join(" ").slice(0, 1_500)}`;
}

export async function htmlSection(full: string, requested: string, index = 0): Promise<string> {
  const parser = new HtmlParser({
    onopentag(name) { if (name === "script" || name === "style") hidden++; if (/^h[1-6]$/.test(name)) { inHeading = true; heading = ""; } },
    ontext(value) {
      if (hidden) return;
      const clean = value.replace(/\s+/g, " ").trim();
      if (inHeading) { if (heading.length < 200) heading += clean.slice(0, 200 - heading.length); }
      else if (active && output.length < 3_000) output += `${clean} `;
    },
    onclosetag(name) {
      if (name === "script" || name === "style") hidden = Math.max(0, hidden - 1);
      if (name === "td" || name === "th") { if (active && output.length < 3_000) output += " | "; }
      if (name === "tr") { if (active && output.length < 3_000) output += "\n"; }
      if (/^h[1-6]$/.test(name)) {
        inHeading = false;
        if (active) active = false;
        if (heading.toLowerCase().includes(requested.toLowerCase())) {
          if (seen === index) { active = true; found = true; output = `${heading}: `; }
          seen++;
        }
      }
    },
  }, { decodeEntities: true });
  let hidden = 0;
  let inHeading = false;
  let heading = "";
  let active = false;
  let found = false;
  let seen = 0;
  let output = "";
  const decoder = new StringDecoder("utf8");
  await feed(full, (chunk) => parser.write(decoder.write(chunk)), () => { parser.write(decoder.end()); parser.end(); });
  return found ? output.slice(0, 3_000) : `Раздел «${requested}» не найден`;
}
