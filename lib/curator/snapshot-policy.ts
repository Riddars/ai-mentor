import { fileKind } from "./file-policy";
export const SNAPSHOT_POLICY_VERSION = "snapshot-files-v2";

const OMIT_DIR = /(?:^|\/)(?:\.git|node_modules|\.next|\.venv|venv|__pycache__|dist|build|coverage)(?:\/|$)/;
const BINARY = /\.(?:png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|tar|7z|exe|dll|so|dylib|pyc|woff2?|ttf|mp[34]|wav|bin|pt|pth|onnx)$/i;
const SECRET = /(?:^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials)(?:$|\/)|\.(?:pem|key|p12|pfx)$/i;
export function sensitivePath(path: string): boolean { return SECRET.test(path); }
/** Paths whose content must not be exposed even by bounded preview/search tools. */
export function pathContentExclusion(path: string): string | null {
  if (OMIT_DIR.test(path)) return "служебный каталог";
  if (SECRET.test(path)) return "файл учётных данных";
  if (BINARY.test(path)) return "двоичный или графический файл";
  return null;
}
/** Shared policy for snapshots, PR patches, whole-file reads and verification. */
export function snapshotExclusion(path: string): string | null {
  const excluded = pathContentExclusion(path);
  if (excluded) return excluded;
  if (/\.pdbqt$/i.test(path)) return "данные молекулярных структур";
  const kind = fileKind(path);
  return kind === "text" ? null : `категория ${kind}`;
}

/** Both sides of a rename/copy follow the stricter policy for this PR. */
export function reviewFileExclusion(path: string, changes: readonly { oldPath: string; newPath: string }[]): string | null {
  const excluded = snapshotExclusion(path);
  if (excluded) return excluded;
  for (const change of changes) {
    if (change.oldPath !== path && change.newPath !== path) continue;
    const reason = snapshotExclusion(change.oldPath) ?? snapshotExclusion(change.newPath);
    if (reason) return reason;
  }
  return null;
}
