import { cn } from "@/lib/utils";

function initials(handle: string): string {
  const cleaned = handle.replace(/^@/, "");
  const parts = cleaned.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

const SIZES = { sm: "size-6 text-[0.6rem]", md: "size-8 text-xs" } as const;

/** Initials in a circle — marks who wrote a comment. */
export function Avatar({
  handle,
  size = "md",
  className,
}: {
  handle: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      title={handle}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-accent-foreground",
        SIZES[size],
        className,
      )}
    >
      {initials(handle)}
    </span>
  );
}
