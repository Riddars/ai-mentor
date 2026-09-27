"use client";

import { useActionState } from "react";
import { decideFindingAction } from "@/app/actions/findings";
import type { ActionState } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { FormMessage, inputClass } from "@/components/admin/fields";

/** Supervisor's override of the model: dismiss an open finding or reopen a closed one. */
export function FindingDecisionForm({ findingId, isOpen }: { findingId: number; isOpen: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(decideFindingAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="findingId" value={findingId} />
      <textarea
        name="reason"
        required
        rows={2}
        placeholder="Причина"
        className={`${inputClass} h-auto py-2`}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {isOpen ? "Закрыть как ложное" : "Вернуть в открытые"}
        </Button>
        <FormMessage state={state} />
      </div>
    </form>
  );
}
