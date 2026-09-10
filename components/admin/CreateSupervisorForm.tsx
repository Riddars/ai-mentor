"use client";

import { useActionState } from "react";
import { createSupervisorAction, type ActionState } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";

const input =
  "h-9 w-full rounded-md border border-border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function CreateSupervisorForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createSupervisorAction,
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <label className="flex flex-1 flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">логин</span>
        <input name="login" autoComplete="off" className={input} />
      </label>
      <label className="flex flex-1 flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">пароль</span>
        <input name="password" type="text" autoComplete="off" className={input} />
      </label>
      <label className="flex flex-1 flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">имя</span>
        <input name="name" className={input} placeholder="необязательно" />
      </label>
      <Button type="submit" disabled={pending}>
        Создать
      </Button>
      {(state?.error || state?.ok) && (
        <p className={`text-xs ${state.error ? "text-red" : "text-green"} sm:self-center`}>
          {state.error ?? state.ok}
        </p>
      )}
    </form>
  );
}
