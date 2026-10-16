"use client";

import { useActionState, useState } from "react";
import { saveProjectNotesAction, startOverviewAction } from "@/app/actions/reviews";
import type { ActionState } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { FormMessage, inputClass } from "@/components/admin/fields";

/** The curator's notes about the project, editable by its supervisor. */
export function ProjectNotes({ projectId, notes }: { projectId: number; notes: string | null }) {
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState<ActionState, FormData>(async (prev, form) => {
    const result = await saveProjectNotesAction(prev, form);
    if (!result?.error) setEditing(false);
    return result;
  }, null);

  if (!editing) {
    return (
      <div className="flex flex-col gap-3">
        {notes ? (
          <p className="text-sm whitespace-pre-wrap">{notes}</p>
        ) : (
          <p className="text-sm text-muted-foreground">Описания пока нет — его составит полный обзор.</p>
        )}
        <div className="flex items-center gap-3">
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
            Изменить
          </Button>
          <FormMessage state={state} />
        </div>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <textarea name="notes" rows={14} defaultValue={notes ?? ""} className={`${inputClass} h-auto py-2`} />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          Сохранить
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setEditing(false)}>
          Отмена
        </Button>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function StartOverviewButton({ projectId }: { projectId: number }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(startOverviewAction, null);
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <FormMessage state={state} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Запустить полный обзор
      </Button>
    </form>
  );
}
