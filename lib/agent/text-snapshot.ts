import { writeFile } from "node:fs/promises";
import { Header } from "tar";
import { githubRequest } from "@/lib/github/api";

interface Entry { path: string; size?: number; mode: string; sha: string; type: string }
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/** Bounded text snapshot when the compressed repository does not fit. Never execute repository code. */
export async function downloadTextSnapshot(base: string, sha: string, token: string, dest: string): Promise<string> {
  const { tree, truncated } = await githubRequest<{ tree: Entry[]; truncated: boolean }>(
    `${base}/git/trees/${sha}?recursive=1`, { token });
  const blocks: Buffer[] = [];
  let bytes = 0;
  let count = 0;
  const files = tree.filter(e => e.type === "blob" && /^100(644|755)$/.test(e.mode));
  const priority = (path: string) => /(?:^|\/)readme(?:\.|$)/i.test(path) ? 0 : path.split("/").length;
  for (const entry of files.sort((a,b) => priority(a.path) - priority(b.path) || a.path.localeCompare(b.path))) {
    if (count >= 80) break;
    if (entry.size === undefined || entry.size > 192 * 1024 || bytes + entry.size > MAX_SNAPSHOT_BYTES ||
        !/\.(md|rst|txt|py|js|tsx?|jsx|cs|go|rs|java|c|cpp|h|rb|php|sh|sql|r|jl|toml|json|ya?ml|csv|tsv|html|css)$/i.test(entry.path)) continue;
    if (entry.path.split("/").some(part => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part))) continue;
    const header = new Header({path: "snapshot/" + entry.path, type: "File", size: entry.size, mode: 0o600});
    const block = Buffer.alloc(512);
    if (header.encode(block)) continue;
    const blob = await githubRequest<{ encoding: string; content: string }>(`${base}/git/blobs/${entry.sha}`, {token});
    if (blob.encoding !== "base64") continue;
    const body = Buffer.from(blob.content, "base64");
    if (body.length !== entry.size || body.includes(0)) continue;
    blocks.push(block, body, Buffer.alloc((512 - body.length % 512) % 512));
    count++;
    bytes += body.length;
  }
  await writeFile(dest, Buffer.concat([...blocks,Buffer.alloc(1024)]));
  return `Выборочная копия: ${count} текстовых файлов из ${files.length} видимых в дереве${truncated ? " (дерево неполное)" : ""}.`;
}
