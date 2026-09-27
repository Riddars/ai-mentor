import * as React from "react";
import { cn } from "@/lib/utils";

/** A card whose body opens on click (native details/summary, no client code). */
export function CollapsibleCard({
  title,
  count,
  className,
  children,
}: {
  title: string;
  count?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <details
      className={cn("group rounded-xl border border-border bg-card text-card-foreground shadow-card", className)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 select-none [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 16 16"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          aria-hidden
        >
          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {count !== undefined && <span className="ml-auto text-xs text-muted-foreground">{count}</span>}
      </summary>
      <div className="px-5 pb-5">{children}</div>
    </details>
  );
}
