import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "red" | "amber" | "green" | "primary";

const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  red: "bg-red-soft text-red",
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

export function StatusDot({ tone }: { tone: "red" | "amber" | "green" }) {
  const color = tone === "red" ? "bg-red" : tone === "amber" ? "bg-amber" : "bg-green";
  return <span className={cn("inline-block size-2.5 shrink-0 rounded-full", color)} />;
}
