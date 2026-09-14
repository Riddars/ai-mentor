"use client";

import { useActionState } from "react";
import { addProjectAction, type ActionState } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { Field, FormMessage, inputClass } from "@/components/admin/fields";

export function AddProjectForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    addProjectAction,
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="owner" className="flex-1">
          <input name="owner" className={inputClass} placeholder="RiddarsCorp" />
        </Field>
        <Field label="repo" className="flex-1">
          <input name="repo" className={inputClass} placeholder="test-project-1" />
        </Field>
        <Field label="название" className="flex-1">
          <input name="name" className={inputClass} placeholder="необязательно" />
        </Field>
        <Button type="submit" disabled={pending}>
          Подключить
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
