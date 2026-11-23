import { open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { hashText, type ContextSource } from "./context-parts";
import { notebookCells } from "./notebook";
import { pathContentExclusion, snapshotExclusion } from "./snapshot-policy";

export interface RepositoryInventory {
  sources: ContextSource[];
  excluded: Array<{ path: string; reason: string; bytes?: number }>;
}
/** scratch must be outside root; the caller owns its lifecycle. No repository content executes. */
export async function repositoryInventory(root: string, revision: string, scratch: string): Promise<RepositoryInventory> {
  const realRoot = await realpath(root);
  const realScratch = await realpath(scratch);
  if (realScratch === realRoot || realScratch.startsWith(realRoot + sep)) throw new Error("Inventory scratch must be outside repository");
  const result: RepositoryInventory = { sources: [], excluded: [] };
  const paths: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const path = relative(realRoot, full).split(sep).join("/");
      if (entry.isSymbolicLink()) { result.excluded.push({ path, reason: "symbolic link; not followed" }); continue; }
      if (entry.isDirectory()) {
        const reason = pathContentExclusion(path + "/");
        if (reason) result.excluded.push({ path: path + "/", reason });
        else await walk(full);
      } else if (entry.isFile()) paths.push(path);
      else result.excluded.push({ path, reason: "not a regular file" });
    }
  };
  await walk(realRoot);
  for (const path of paths.sort()) {
    const reason = snapshotExclusion(path);
    const full = await realpath(join(realRoot, path));
    if (!full.startsWith(realRoot + sep)) throw new Error("Inventory path escaped repository");
    const bytes = (await stat(full)).size;
    if (!reason && bytes > 50 * 1024 * 1024) throw new Error(`incomplete_snapshot: file exceeds safe loading limit: ${path}`);
    let text: string;
    let originalHash: string;
    let transformation: string;
    if (reason) {
      const metadata = { path, reason, bytes };
      result.excluded.push(metadata);
      text = JSON.stringify(metadata);
      originalHash = hashText(text);
      transformation = "file-metadata-only-v1";
    } else {
      const raw = await readFile(full);
      originalHash = hashText(raw);
      transformation = "utf8-identity-v1";
      try {
        if (raw.includes(0)) throw new Error("binary");
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
      } catch { result.excluded.push({ path, reason: "binary or unsupported encoding", bytes }); continue; }
      if (/\.ipynb$/i.test(path)) {
        const cells = notebookCells(text);
        if (cells === null) throw new Error(`incomplete_snapshot: invalid notebook: ${path}`);
        text = cells;
        transformation = "notebook-code-markdown-v1";
      }
    }
    const view = Buffer.from(text, "utf8");
    const viewHash = hashText(view);
    const id = hashText(JSON.stringify([revision, path, transformation, originalHash, viewHash]));
    const stored = join(realScratch, id);
    await writeFile(stored, view, { flag: "wx", mode: 0o600 });
    const byteLength = view.length;
    result.sources.push({ id, path, revision, kind: reason ? "metadata" : "file", bytes: byteLength, originalHash, viewHash, transformation,
      async read(from, to) {
        if (from < 0 || to < from || to > byteLength) throw new Error("Invalid inventory read range");
        const handle = await open(stored, "r");
        try {
          const buffer = Buffer.alloc(to - from);
          let offset = 0;
          while (offset < buffer.length) {
            const read = await handle.read(buffer, offset, buffer.length - offset, from + offset);
            if (!read.bytesRead) throw new Error("Inventory artifact truncated");
            offset += read.bytesRead;
          }
          return buffer;
        } finally { await handle.close(); }
      } });
  }
  result.excluded.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.reason < b.reason ? -1 : 1);
  return result;
}
