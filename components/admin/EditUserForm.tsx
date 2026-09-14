"use client";

import { useActionState } from "react";
import {
  setUserDisabledAction,
  setUserPasswordAction,
  updateUserAction,
  type ActionState,
} from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { Field, FormMessage, inputClass } from "@/components/admin/fields";

type UserProps = { id: string; login: string; name: string | null; role: string; disabled: boolean };

export function EditUserForm({ user }: { user: UserProps }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateUserAction,
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="userId" value={user.id} />
      <div className="flex flex-col gap-3 sm:flex-row">
        <Field label="логин" className="flex-1">
          <input name="login" defaultValue={user.login} autoComplete="off" className={inputClass} />
        </Field>
        <Field label="имя" className="flex-1">
          <input name="name" defaultValue={user.name ?? ""} className={inputClass} />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          Сохранить
        </Button>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function SetPasswordForm({ user }: { user: UserProps }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    setUserPasswordAction,
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="userId" value={user.id} />
      <Field label="новый пароль">
        <input name="password" type="text" autoComplete="new-password" className={inputClass} />
      </Field>
      <p className="text-xs text-muted-foreground">
        После смены пароля все открытые сессии этой учётной записи завершаются.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          Задать пароль
        </Button>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function ToggleDisabledForm({ user }: { user: UserProps }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    setUserDisabledAction,
    null,
  );
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="userId" value={user.id} />
      <input type="hidden" name="disabled" value={user.disabled ? "0" : "1"} />
      <Button variant="outline" size="sm" type="submit" disabled={pending}>
        {user.disabled ? "Включить" : "Отключить"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
