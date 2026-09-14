"use client";

import { useActionState } from "react";
import { createSupervisorAction, type ActionState } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { Field, FormMessage, inputClass } from "@/components/admin/fields";

export function CreateSupervisorForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createSupervisorAction,
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="логин" className="flex-1">
          <input name="login" autoComplete="off" className={inputClass} />
        </Field>
        <Field label="пароль" className="flex-1">
          <input name="password" type="text" autoComplete="off" className={inputClass} />
        </Field>
        <Field label="имя" className="flex-1">
          <input name="name" className={inputClass} placeholder="необязательно" />
        </Field>
        <Button type="submit" disabled={pending}>
          Создать
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
