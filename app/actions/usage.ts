"use server";

import { revalidatePath } from "next/cache";
import { addBalanceEntry, deleteBalanceEntry } from "@/lib/curator/store";
import { getViewer } from "@/lib/users";
import type { ActionState } from "@/app/actions/admin";

const PROVIDER = /^[a-z0-9_-]{1,40}$/;

async function requireHeadLogin(): Promise<string> {
  const viewer = await getViewer();
  if (!viewer || viewer.role !== "head") {
    throw new Error("Доступ только для руководителя центра.");
  }
  return viewer.login;
}

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function addBalanceEntryAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireHeadLogin();
  const provider = str(form, "provider");
  const kind = str(form, "kind");
  const amountText = str(form, "amount").replace(/\s/g, "").replace(",", ".");
  const amountRub = amountText ? Number(amountText) : NaN;
  if (!PROVIDER.test(provider)) return { error: "Выберите провайдера." };
  if (kind !== "topup" && kind !== "balance") return { error: "Выберите, что записать." };
  if (!Number.isFinite(amountRub) || amountRub < 0 || (kind === "topup" && amountRub === 0)) {
    return { error: "Укажите сумму в рублях." };
  }
  addBalanceEntry({ provider, kind, amountRub, actor });
  revalidatePath("/usage");
  return { ok: "Записано." };
}

export async function deleteBalanceEntryAction(form: FormData): Promise<void> {
  await requireHeadLogin();
  const id = Number(str(form, "id"));
  if (Number.isInteger(id)) {
    deleteBalanceEntry(id);
    revalidatePath("/usage");
  }
}
