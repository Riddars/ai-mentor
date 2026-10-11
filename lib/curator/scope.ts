import type { FindingLocation } from "@/lib/curator/finding";

// Where a finding lives. A "project" finding points at code that is already in the main
// branch; a "branch" finding points at code that exists only in the changes of its PR.
// Only the PR that raised a branch finding may reconcile it; project findings are open to
// every PR of the project. No database access here.

export type FindingScope = "branch" | "project";

/**
 * Changed files of a PR with the line numbers its patch adds; null when the lines are
 * unknown (no textual patch, or a notebook whose cell lines do not match the JSON patch).
 */
export type ChangedLines = Map<string, Set<number> | null>;

export function lineRange(detail: string | null | undefined): { from: number; to: number } | null {
  const match = detail?.match(/(\d+)(?:\s*[-–—]\s*(\d+))?/);
  if (!match) return null;
  const from = Number(match[1]);
  const to = match[2] ? Number(match[2]) : from;
  return from >= 1 && to >= from ? { from, to } : null;
}

/** New-file line numbers added by a unified diff patch. */
export function addedLines(patch: string): Set<number> {
  const added = new Set<number>();
  let line = 0;
  for (const text of patch.split("\n")) {
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
    } else if (text.startsWith("+")) {
      added.add(line);
      line += 1;
    } else if (text.startsWith(" ")) {
      line += 1;
    }
  }
  return added;
}

export function changedLines(files: Array<{ filename: string; patch?: string }>): ChangedLines {
  return new Map(
    files.map((f) => [
      f.filename,
      f.patch && !f.filename.toLowerCase().endsWith(".ipynb") ? addedLines(f.patch) : null,
    ]),
  );
}

/** Repository path of a cited place; null for free text (a section name, a description). */
function placePath(location: FindingLocation): string | null {
  if (location.kind === "other") return null;
  const path = location.target.trim().replace(/^\.?\/+/, "");
  if (location.kind === "file") return path;
  return /^[\w.\-/]+$/.test(path) && /[./]/.test(path) ? path : null;
}

/** Whether a place cited by a finding is touched by the PR's changes. */
function touched(location: FindingLocation, changed: ChangedLines): boolean {
  const path = placePath(location);
  if (path === null || !changed.has(path)) return false;
  const lines = changed.get(path);
  const range = location.kind === "file" ? lineRange(location.detail) : null;
  if (!lines || !range) return true;
  for (let n = range.from; n <= range.to; n++) {
    if (lines.has(n)) return true;
  }
  return false;
}

/**
 * Scope of a new finding: a finding of a PR already merged into the main branch, or one whose
 * cited places all exist outside the PR's changes, belongs to the project; anything else,
 * including a finding without cited places, belongs to the PR's branch.
 */
export function findingScope(
  locations: FindingLocation[],
  changed: ChangedLines,
  mergedIntoDefault: boolean,
): FindingScope {
  if (mergedIntoDefault) return "project";
  const places = locations.filter((l) => placePath(l) !== null);
  if (places.length === 0) return "branch";
  return places.some((l) => touched(l, changed)) ? "branch" : "project";
}

/**
 * A fix must show in the PR's changes: a finding with cited places may be closed only by a
 * PR that changed one of the cited files. A finding without cited places is not limited.
 */
export function fixVisible(locations: FindingLocation[], changedFiles: ReadonlySet<string>): boolean {
  const paths = locations.map(placePath).filter((p): p is string => p !== null);
  return paths.length === 0 || paths.some((p) => changedFiles.has(p));
}
