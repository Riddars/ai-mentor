import type { ActionState } from "@/app/actions/admin";

// Shared bits for the admin forms: one input style, a labelled field, and the
// ok/error line that useActionState feeds.

export const inputClass =
  "h-9 w-full rounded-md border border-border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function FormMessage({ state }: { state: ActionState }) {
  if (!state?.error && !state?.ok) return null;
  return (
    <p className={`text-xs ${state.error ? "text-red" : "text-green"}`}>
      {state.error ?? state.ok}
    </p>
  );
}
