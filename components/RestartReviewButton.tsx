"use client";

import { useActionState } from "react";
import { restartReviewAction } from "@/app/actions/reviews";
import type { ActionState } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { FormMessage } from "@/components/admin/fields";

export function RestartReviewButton({ prId }: { prId: number }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(restartReviewAction, null);
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="prId" value={prId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Перезапустить разбор
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
