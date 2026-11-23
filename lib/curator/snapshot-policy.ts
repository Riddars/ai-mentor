import { fileKind } from "./file-policy";
export const SNAPSHOT_POLICY_VERSION = "snapshot-files-v3";

const REVIEWABLE_EXTENSION = /\.(?:py|pyi|pyx|pxd|r|rmd|qmd|jl|m|js|jsx|mjs|cjs|ts|tsx|mts|cts|c|h|cc|cpp|cxx|hh|hpp|hxx|cu|cuh|f|f90|f95|f03|f08|go|rs|java|kt|kts|scala|cs|fs|fsx|swift|rb|php|lua|pl|pm|sh|bash|zsh|ps1|bat|cmd|sql|nf|smk|wdl|cwl|css|scss|sass|less|vue|svelte|md|mdx|rst|adoc|tex|yaml|yml|toml|ini|cfg|cmake|proto|ipynb)$/i;
const REVIEWABLE_NAME = /^(?:readme(?:\.txt)?|changelog(?:\.txt)?|license(?:\.txt)?|dockerfile(?:\.[^/]+)?|containerfile|makefile|gnumakefile|cmakelists\.txt|snakefile|requirements(?:-[^/]+)?\.txt|nextflow\.config|package\.json|tsconfig(?:\.[^/]+)?\.json|jsconfig\.json|composer\.json|pom\.xml|nuget\.config)$/i;

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
  if (kind !== "text") return `категория ${kind}`;
  const name = path.split("/").at(-1) ?? "";
  return REVIEWABLE_EXTENSION.test(name) || REVIEWABLE_NAME.test(name) ? null : "формат отсутствует в списке анализа";
}

export function changedFileExclusion(oldPath: string, newPath: string): string | null {
  const excluded = snapshotExclusion(oldPath) ?? snapshotExclusion(newPath);
  if (excluded) return excluded;
  return /\.ipynb$/i.test(oldPath) !== /\.ipynb$/i.test(newPath) ? "формат ноутбука изменился" : null;
}

/** Both sides of a rename/copy follow the stricter policy for this PR. */
export function reviewFileExclusion(path: string, changes: readonly { oldPath: string; newPath: string }[]): string | null {
  const excluded = snapshotExclusion(path);
  if (excluded) return excluded;
  for (const change of changes) {
    if (change.oldPath !== path && change.newPath !== path) continue;
    const reason = changedFileExclusion(change.oldPath, change.newPath);
    if (reason) return reason;
  }
  return null;
}
