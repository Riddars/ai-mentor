import { open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { hashText, type ContextSource } from "./context-parts";
import { notebookCells } from "./notebook";
import { snapshotExclusion } from "./snapshot-policy";

export interface RepositoryInventory {
  sources: ContextSource[];
  excluded: Array<{ path: string; reason: string }>;
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
        const reason = snapshotExclusion(path + "/");
        if (reason) result.excluded.push({ path: path + "/", reason });
        else await walk(full);
      } else if (entry.isFile()) paths.push(path);
      else result.excluded.push({ path, reason: "not a regular file" });
    }
  };
  await walk(realRoot);
  for (const path of paths.sort()) {
    const reason = snapshotExclusion(path);
    const settingsTemplate = /(?:^|\/)\.env\.(?:example|sample|template)$/i.test(path);
    const dataMetadata = reason === "категория data" || /\.pdbqt$/i.test(path);
    if (reason && !settingsTemplate && !dataMetadata) { result.excluded.push({ path, reason }); continue; }
    const full = await realpath(join(realRoot, path));
    if (!full.startsWith(realRoot + sep)) throw new Error("Inventory path escaped repository");
    if ((await stat(full)).size > 50 * 1024 * 1024) throw new Error(`incomplete_snapshot: file exceeds safe loading limit: ${path}`);
    const raw = await readFile(full);
    let text: string;
    let transformation = "utf8-identity-v1";
    if (dataMetadata) {
      text = JSON.stringify({ path, bytes: raw.length, content: "excluded; metadata only",
        format: path.split(".").pop() });
      transformation = "data-size-format-v1";
      result.excluded.push({ path, reason: reason + "; values not transmitted, metadata only" });
    } else {
    try {
      if (raw.includes(0)) throw new Error("binary");
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    } catch { result.excluded.push({ path, reason: "binary or unsupported encoding" }); continue; }
    }
    const originalHash = hashText(raw);
    if (settingsTemplate) {
      const names = [...new Set([...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(match => match[1]))];
      text = JSON.stringify({ path, settingNames: names, values: "not transmitted" });
      transformation = "environment-setting-names-v1";
      result.excluded.push({ path, reason: "setting values omitted; names only" });
    }
    if (/\.ipynb$/i.test(path)) {
      const cells = notebookCells(text);
      if (cells === null) throw new Error(`incomplete_snapshot: invalid notebook: ${path}`);
      text = cells; transformation = "notebook-code-markdown-v1";
    }
    const view = Buffer.from(text, "utf8");
    const viewHash = hashText(view);
    const id = hashText(JSON.stringify([revision, path, transformation, originalHash, viewHash]));
    const stored = join(realScratch, id);
    await writeFile(stored, view, { flag: "wx", mode: 0o600 });
    const byteLength = view.length;
    result.sources.push({ id, path, revision, kind: dataMetadata || settingsTemplate ? "metadata" : "file", bytes: byteLength, originalHash, viewHash, transformation,
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
