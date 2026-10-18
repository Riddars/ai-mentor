"use client";

import { useActionState } from "react";
import { resetCorePromptAction, saveCorePromptAction, type ActionState } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { FormMessage, inputClass } from "@/components/admin/fields";

/** The editable core of the curator's prompt, with a way back to the default text. */
export function CorePromptForm({ text, custom }: { text: string; custom: boolean }) {
  const [saveState, save, saving] = useActionState<ActionState, FormData>(saveCorePromptAction, null);
  const [resetState, reset, resetting] = useActionState<ActionState, FormData>(resetCorePromptAction, null);
  const pending = saving || resetting;

  return (
    <div className="flex flex-col gap-2">
      {/* The key reloads the text after a reset. */}
      <form key={text} action={save} className="flex flex-col gap-2">
        <textarea name="text" rows={24} defaultValue={text} className={`${inputClass} h-auto py-2 font-mono text-xs`} />
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={pending}>
            Сохранить
          </Button>
          <FormMessage state={saveState} />
        </div>
      </form>
      {custom && (
        <form
          action={reset}
          onSubmit={(e) => {
            if (!window.confirm("Вернуть текст по умолчанию? Изменённый текст будет удалён.")) e.preventDefault();
          }}
          className="flex items-center gap-3"
        >
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            Вернуть по умолчанию
          </Button>
          <FormMessage state={resetState} />
        </form>
      )}
    </div>
  );
}
