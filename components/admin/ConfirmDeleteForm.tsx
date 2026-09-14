"use client";

import { useActionState } from "react";
import type { ActionState } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { FormMessage, inputClass } from "@/components/admin/fields";

/**
 * Danger-zone form: the user must retype `expected` to enable the delete. The
 * server action re-checks the match, so the client is only a convenience.
 */
export function ConfirmDeleteForm({
  action,
  hidden,
  expected,
  label,
  children,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  hidden: Record<string, string | number>;
  expected: string;
  label: string;
  children?: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {children}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Введите <code className="rounded bg-muted px-1">{expected}</code> для подтверждения
        </span>
        <input name="confirm" autoComplete="off" className={`${inputClass} sm:max-w-xs`} />
      </label>
      <div className="flex items-center gap-3">
        <Button variant="destructive" size="sm" type="submit" disabled={pending}>
          {label}
        </Button>
        <FormMessage state={state} />
      </div>
    </form>
  );
}
