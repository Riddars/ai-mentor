"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";

const inputClass =
  "h-9 w-full rounded-md border border-border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(
    loginAction,
    null,
  );

  return (
    <form action={action} className="flex w-full max-w-xs flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="login" className="text-xs font-medium text-muted-foreground">
          Логин
        </label>
        <input id="login" name="login" autoComplete="username" className={inputClass} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-xs font-medium text-muted-foreground">
          Пароль
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          className={inputClass}
        />
      </div>
      {state?.error && <p className="text-xs text-red">{state.error}</p>}
      <Button type="submit" disabled={pending} className="mt-1">
        {pending ? "Вход…" : "Войти"}
      </Button>
    </form>
  );
}
