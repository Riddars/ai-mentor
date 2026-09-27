"use server";

import { revalidatePath } from "next/cache";
import { getFinding, isSupervisorOf, setFindingStatusByPerson } from "@/lib/curator/store";
import { isOpenStatus } from "@/lib/format";
import { getViewer } from "@/lib/users";
import type { ActionState } from "@/app/actions/admin";

/**
 * A supervisor of the project (or the head) overrides the model: dismisses an open
 * finding as false, or reopens a closed or dismissed one. A reason is required.
 */
export async function decideFindingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const viewer = await getViewer();
  if (!viewer) return { error: "Требуется вход." };

  const finding = getFinding(Number(formData.get("findingId")));
  if (!finding) return { error: "Замечание не найдено." };
  if (viewer.role !== "head" && !isSupervisorOf(viewer.userId, finding.projectId)) {
    return { error: "Нет доступа к этому проекту." };
  }

  const reason = String(formData.get("reason") ?? "").trim();
  if (reason === "") return { error: "Укажите причину." };

  setFindingStatusByPerson({
    findingId: finding.id,
    status: isOpenStatus(finding.status) ? "dismissed" : "open",
    reason,
    actor: viewer.login,
  });
  revalidatePath(`/projects/${finding.projectId}`);
  revalidatePath(`/projects/${finding.projectId}/findings/${finding.id}`);
  return { ok: "Сохранено." };
}
