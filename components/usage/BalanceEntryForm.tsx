"use client";

import { useActionState } from "react";
import { addBalanceEntryAction } from "@/app/actions/usage";
import type { ActionState } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { Field, FormMessage, inputClass } from "@/components/admin/fields";

export function BalanceEntryForm({ providers }: { providers: { id: string; label: string }[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addBalanceEntryAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="провайдер" className="flex-1">
          <select name="provider" defaultValue={providers[0]?.id ?? ""} className={inputClass}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="запись" className="flex-1">
          <select name="kind" defaultValue="topup" className={inputClass}>
            <option value="topup">пополнение</option>
            <option value="balance">остаток в кабинете</option>
          </select>
        </Field>
        <Field label="сумма, ₽" className="flex-1">
          <input name="amount" inputMode="decimal" className={inputClass} placeholder="5000" />
        </Field>
        <Button type="submit" disabled={pending}>
          Записать
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
