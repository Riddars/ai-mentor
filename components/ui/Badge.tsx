import * as React from "react";
import { cn } from "@/lib/utils";
import { severityKey, severityLabel } from "@/lib/format";

export type Tone = "neutral" | "red" | "orange" | "amber" | "green" | "primary";

const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  red: "bg-red-soft text-red",
  orange: "bg-orange-soft text-orange",
  amber: "bg-amber-soft text-amber",
  green: "bg-green-soft text-green",
  primary: "bg-accent text-accent-foreground",
};

export function Badge({
  className,
  tone = "neutral",
  ...props
}: React.ComponentProps<"span"> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

const DOT_COLOR: Record<Tone, string> = {
  neutral: "bg-muted-foreground/60",
  red: "bg-red",
  orange: "bg-orange",
  amber: "bg-amber",
  green: "bg-green",
  primary: "bg-primary",
};

/** A small solid dot — used inline to mark severity next to a finding title. */
export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT_COLOR[tone], className)}
      aria-hidden
    />
  );
}

// Severity is an ordinal ramp (amber → orange → red). A status colour never
// carries meaning alone, so it is always shown next to its text label.
export function severityTone(severity: string | null): Tone {
  switch (severityKey(severity)) {
    case "critical":
      return "red";
    case "high":
      return "orange";
    case "medium":
      return "amber";
    default:
      return "neutral";
  }
}

export function SeverityBadge({ severity }: { severity: string | null }) {
  const tone = severityTone(severity);
  return (
    <Badge tone={tone}>
      <Dot tone={tone} />
      {severityLabel(severity)}
    </Badge>
  );
}
