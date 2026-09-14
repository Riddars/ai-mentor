"use client";

import { useActionState } from "react";
import { updateProjectAction, type ActionState } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { Field, FormMessage, inputClass } from "@/components/admin/fields";

export function EditProjectForm({
  project,
  canRename,
}: {
  project: { id: number; owner: string; repo: string; name: string | null };
  canRename: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateProjectAction,
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="projectId" value={project.id} />
      <Field label="название">
        <input name="name" defaultValue={project.name ?? ""} className={inputClass} />
      </Field>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Field label="owner" className="flex-1">
          <input name="owner" defaultValue={project.owner} className={inputClass} disabled={!canRename} />
        </Field>
        <Field label="repo" className="flex-1">
          <input name="repo" defaultValue={project.repo} className={inputClass} disabled={!canRename} />
        </Field>
      </div>
      {!canRename && (
        <p className="text-xs text-muted-foreground">
          owner/repo заблокированы: по проекту уже были pull requests, и переименование
          оборвало бы связь с событиями GitHub.
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          Сохранить
        </Button>
        <FormMessage state={state} />
      </div>
    </form>
  );
}
