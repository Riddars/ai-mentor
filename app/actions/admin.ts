"use server";

import { revalidatePath } from "next/cache";
import {
  assignSupervisor,
  createProjectManual,
  setProjectStatus,
  unassignSupervisor,
  type ProjectStatus,
} from "@/lib/curator/store";
import { createUser, findUserByLogin, getViewer, setUserDisabled } from "@/lib/users";

export type ActionState = { error?: string; ok?: string } | null;

async function requireHead(): Promise<void> {
  const viewer = await getViewer();
  if (!viewer || viewer.role !== "head") {
    throw new Error("Доступ только для руководителя центра.");
  }
}

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function refresh(): void {
  revalidatePath("/admin");
  revalidatePath("/");
}

export async function addProjectAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireHead();
  const owner = str(form, "owner");
  const repo = str(form, "repo");
  const name = str(form, "name");
  if (!owner || !repo) return { error: "Укажите owner и repo." };
  createProjectManual(owner, repo, name || undefined);
  refresh();
  return { ok: `Проект ${owner}/${repo} подключён.` };
}

export async function setProjectStatusAction(form: FormData): Promise<void> {
  await requireHead();
  const id = Number(str(form, "projectId"));
  const status = str(form, "status") as ProjectStatus;
  if (!Number.isNaN(id) && ["active", "paused", "archived"].includes(status)) {
    setProjectStatus(id, status);
    refresh();
  }
}

export async function assignSupervisorAction(form: FormData): Promise<void> {
  await requireHead();
  const projectId = Number(str(form, "projectId"));
  const userId = str(form, "userId");
  if (!Number.isNaN(projectId) && userId) {
    assignSupervisor(projectId, userId);
    refresh();
  }
}

export async function unassignSupervisorAction(form: FormData): Promise<void> {
  await requireHead();
  const projectId = Number(str(form, "projectId"));
  const userId = str(form, "userId");
  if (!Number.isNaN(projectId) && userId) {
    unassignSupervisor(projectId, userId);
    refresh();
  }
}

export async function createSupervisorAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireHead();
  const login = str(form, "login");
  const password = str(form, "password");
  const name = str(form, "name");
  if (login.length < 2) return { error: "Логин слишком короткий." };
  if (password.length < 6) return { error: "Пароль не короче 6 символов." };
  if (findUserByLogin(login)) return { error: "Такой логин уже занят." };
  await createUser({ login, password, role: "supervisor", name: name || undefined });
  refresh();
  return { ok: `Руководитель ${login} создан.` };
}

export async function setUserDisabledAction(form: FormData): Promise<void> {
  await requireHead();
  const userId = str(form, "userId");
  const disabled = str(form, "disabled") === "1";
  if (userId) {
    setUserDisabled(userId, disabled);
    refresh();
  }
}
