// Shape of a finding shared by the curator, the store and the panel. No database
// access here, so client components can import it.

/** What a finding is about. A fixed list, so the panel can label and group it. */
export const FINDING_AREAS = [
  "code",
  "data",
  "methodology",
  "reproducibility",
  "problem",
  "reasoning",
  "novelty",
  "plan",
] as const;
export type FindingArea = (typeof FINDING_AREAS)[number];

/** Ordered from most to least serious. */
export const SEVERITIES = ["critical", "important", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const LOCATION_KINDS = ["file", "document", "data", "other"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/** One piece of ground for a finding: a file, a document section, a dataset or free text. */
export interface FindingLocation {
  kind: LocationKind;
  target: string;
  detail?: string | null;
}
