import { isDataFile } from "@/lib/curator/data-files";

const LOCK = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock|Pipfile\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock)$/i;
const GENERATED = /(?:\.min\.(?:js|css)|\.(?:js|css)\.map)$/i;
const LOG = /\.(?:log|out|err|trace|prof)$/i;
const JSON_LINES = /\.(?:jsonl|ndjson)$/i;

export type FileKind = "data" | "jsonl" | "log" | "generated" | "text";

export function fileKind(path: string): FileKind {
  if (JSON_LINES.test(path)) return "jsonl";
  if (isDataFile(path)) return "data";
  if (LOG.test(path)) return "log";
  if (LOCK.test(path) || GENERATED.test(path)) return "generated";
  return "text";
}

export function isRestrictedFile(path: string): boolean {
  return fileKind(path) !== "text";
}
