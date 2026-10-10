import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { extract, type ReadEntry } from "tar";
import { notebookCells } from "@/lib/curator/notebook";

// The repository copy the agent works on: a GitHub tarball unpacked with every entry checked
// before anything is written, plus a map of what is there and what was left out.

export interface ExtractLimits {
  /** Files larger than this are skipped and noted in the map. */
  maxFileBytes: number;
  /** Total size of written files; extraction stops when exceeded. */
  maxTotalBytes: number;
  maxFiles: number;
  /** Bytes of archive entries read in total, written or not (decompression bomb guard). */
  maxReadBytes: number;
}

export const DEFAULT_LIMITS: ExtractLimits = {
  maxFileBytes: 50 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  maxFiles: 20_000,
  maxReadBytes: 2 * 1024 * 1024 * 1024,
};

export interface SkippedEntry {
  path: string;
  reason: string;
}

export interface ExtractResult {
  skipped: SkippedEntry[];
  /** Set when extraction stopped early on a limit; the copy is then partial. */
  stoppedOn: string | null;
}

const WRITABLE = new Set(["File", "OldFile", "ContiguousFile", "Directory"]);

/** Archive path without the top-level `owner-repo-sha/` directory, or null if unsafe. */
function safeRelativePath(raw: string): string | null {
  if (raw.includes("\\") || raw.includes("\0") || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    return null;
  }
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  return parts.slice(1).join("/");
}

/** Unpack a GitHub tarball into `dest`, writing only regular files and directories. */
export async function extractTarball(
  tarPath: string,
  dest: string,
  limits: ExtractLimits = DEFAULT_LIMITS,
): Promise<ExtractResult> {
  const skipped: SkippedEntry[] = [];
  let files = 0;
  let written = 0;
  let read = 0;
  let stoppedOn: string | null = null;
  const source = createReadStream(tarPath);

  const stop = (reason: string) => {
    stoppedOn ??= reason;
    source.destroy(new Error(reason));
  };

  const filter = (raw: string, entry: ReadEntry | unknown): boolean => {
    const e = entry as ReadEntry;
    read += e.size ?? 0;
    if (read > limits.maxReadBytes) {
      stop(`archive is larger than ${limits.maxReadBytes} bytes unpacked`);
      return false;
    }
    const path = safeRelativePath(raw);
    if (path === null) {
      skipped.push({ path: raw, reason: "unsafe path" });
      return false;
    }
    if (path === "") return false;
    if (!WRITABLE.has(e.type)) {
      const target = e.linkpath ? ` → ${e.linkpath}` : "";
      skipped.push({ path, reason: `${e.type}${target}, not unpacked` });
      return false;
    }
    if (e.type === "Directory") return true;
    if (e.size > limits.maxFileBytes) {
      skipped.push({ path, reason: `file of ${formatSize(e.size)}, larger than the limit` });
      return false;
    }
    files += 1;
    written += e.size;
    if (files > limits.maxFiles) {
      stop(`more than ${limits.maxFiles} files`);
      return false;
    }
    if (written > limits.maxTotalBytes) {
      stop(`more than ${formatSize(limits.maxTotalBytes)} of files`);
      return false;
    }
    return true;
  };

  try {
    await pipeline(source, extract({ cwd: dest, strip: 1, filter, preservePaths: false }));
  } catch (error) {
    if (stoppedOn === null) throw error;
  }
  return { skipped, stoppedOn };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface RepoFile {
  path: string;
  size: number;
}

/** All regular files under `root`, as POSIX paths relative to it. */
export async function listRepoFiles(root: string): Promise<RepoFile[]> {
  const out: RepoFile[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        out.push({ path: relative(root, full).split(sep).join("/"), size: (await stat(full)).size });
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The repository map shown to the agent: files with sizes and entries left out. */
export function repoMap(files: RepoFile[], extracted: ExtractResult, maxLines = 300): string {
  const lines = files.slice(0, maxLines).map((f) => `${f.path} (${formatSize(f.size)})`);
  if (files.length > maxLines) {
    lines.push(`… ещё ${files.length - maxLines} файлов — смотри через list_files`);
  }
  if (extracted.skipped.length > 0) {
    lines.push("", "Не распаковано:");
    lines.push(...extracted.skipped.slice(0, 50).map((s) => `${s.path} — ${s.reason}`));
  }
  if (extracted.stoppedOn) {
    lines.push("", `Копия неполная: распаковка остановлена (${extracted.stoppedOn}).`);
  }
  return lines.join("\n");
}

const PY_IMPORT = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;

/**
 * Repository files imported by the changed Python files and notebooks: the code a change
 * most likely depends on.
 */
export async function relatedFiles(root: string, changed: string[], files: RepoFile[]): Promise<string[]> {
  const known = new Set(files.map((f) => f.path));
  // Modules imported through sys.path tweaks: matched by file name when it is unique.
  const byName = new Map<string, string[]>();
  for (const f of files) {
    const name = posix.basename(f.path);
    byName.set(name, [...(byName.get(name) ?? []), f.path]);
  }
  const related = new Set<string>();
  for (const path of changed) {
    if (!known.has(path) || !/\.(py|ipynb)$/i.test(path)) continue;
    const raw = await readFile(join(root, path), "utf8");
    const text = path.toLowerCase().endsWith(".ipynb") ? (notebookCells(raw) ?? "") : raw;
    const dir = posix.dirname(path);
    for (const match of text.matchAll(PY_IMPORT)) {
      const modulePath = (match[1] ?? match[2]).replace(/\./g, "/");
      const candidates = [`${modulePath}.py`, `${modulePath}/__init__.py`, posix.join(dir, `${modulePath}.py`)]
        .map((c) => posix.normalize(c))
        .filter((c) => known.has(c));
      const sameName = byName.get(`${posix.basename(modulePath)}.py`) ?? [];
      if (candidates.length === 0 && sameName.length === 1) candidates.push(sameName[0]);
      for (const candidate of candidates) {
        if (candidate !== path) related.add(candidate);
      }
    }
  }
  return [...related].sort();
}
