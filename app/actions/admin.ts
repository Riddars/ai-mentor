"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  assignSupervisor,
  createProjectManual,
  deleteProjectCascade,
  getProject,
  getProjectByRepo,
  projectHasPullRequests,
  setProjectStatus,
  unassignSupervisor,
  updateProject,
  type ProjectStatus,
} from "@/lib/curator/store";
import {
  createUser,
  deleteUser,
  findUserById,
  findUserByLogin,
  getViewer,
  setUserDisabled,
  setUserPassword,
  updateUser,
} from "@/lib/users";

export type ActionState = { error?: string; ok?: string } | null;

const MIN_PASSWORD = 6;

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
  revalidatePath("/", "layout");
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

// GitHub owner/repo names: letters, digits, "-", "_" and "."; nothing else can
// ever match a webhook payload.
const REPO_NAME = /^[A-Za-z0-9_.-]+$/;

function validRepoName(s: string): boolean {
  return s.length > 0 && s.length <= 100 && REPO_NAME.test(s);
}

// --- Projects ---

export async function addProjectAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireHead();
  const owner = str(form, "owner");
  const repo = str(form, "repo");
  const name = str(form, "name");
  if (!owner || !repo) return { error: "Укажите owner и repo." };
  if (!validRepoName(owner) || !validRepoName(repo)) {
    return { error: "owner и repo — как в адресе GitHub: латиница, цифры, «-», «_», «.»." };
  }
  if (getProjectByRepo(owner, repo)) return { error: `Проект ${owner}/${repo} уже подключён.` };
  createProjectManual(owner, repo, name || undefined);
  refresh();
  return { ok: `Проект ${owner}/${repo} подключён.` };
}

export async function updateProjectAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireHead();
  const id = Number(str(form, "projectId"));
  const project = Number.isNaN(id) ? null : getProject(id);
  if (!project) return { error: "Проект не найден." };

  const name = str(form, "name") || null;
  let owner = project.owner;
  let repo = project.repo;
  const newOwner = str(form, "owner");
  const newRepo = str(form, "repo");
  const renaming =
    (newOwner && newOwner !== project.owner) || (newRepo && newRepo !== project.repo);
  if (renaming) {
    // Renaming breaks the link with webhook events for an active project.
    if (projectHasPullRequests(id)) {
      return { error: "owner/repo нельзя менять у проекта, по которому уже были pull requests." };
    }
    owner = newOwner || owner;
    repo = newRepo || repo;
    if (!validRepoName(owner) || !validRepoName(repo)) {
      return { error: "owner и repo — как в адресе GitHub: латиница, цифры, «-», «_», «.»." };
    }
    const clash = getProjectByRepo(owner, repo);
    if (clash && clash.id !== id) return { error: `Проект ${owner}/${repo} уже существует.` };
  }

  try {
    updateProject(id, { owner, repo, name });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: `Проект ${owner}/${repo} уже существует.` };
    throw error;
  }
  refresh();
  return { ok: "Сохранено." };
}

export async function setProjectStatusAction(form: FormData): Promise<void> {
  await requireHead();
  const id = Number(str(form, "projectId"));
  const status = str(form, "status") as ProjectStatus;
  if (!Number.isNaN(id) && (status === "active" || status === "paused")) {
    setProjectStatus(id, status);
    refresh();
  }
}

export async function deleteProjectAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireHead();
  const id = Number(str(form, "projectId"));
  const project = Number.isNaN(id) ? null : getProject(id);
  if (!project) return { error: "Проект не найден." };
  const expected = `${project.owner}/${project.repo}`;
  if (str(form, "confirm") !== expected) {
    return { error: `Для подтверждения введите ${expected}.` };
  }
  deleteProjectCascade(id);
  refresh();
  redirect("/admin");
}

export async function assignSupervisorAction(form: FormData): Promise<void> {
  await requireHead();
  const projectId = Number(str(form, "projectId"));
  const userId = str(form, "userId");
  const user = userId ? findUserById(userId) : null;
  if (!Number.isNaN(projectId) && user && user.role === "supervisor") {
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

// --- Users ---

export async function createSupervisorAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireHead();
  const login = str(form, "login");
  const password = str(form, "password");
  const name = str(form, "name");
  if (login.length < 2) return { error: "Логин слишком короткий." };
  if (password.length < MIN_PASSWORD) return { error: `Пароль не короче ${MIN_PASSWORD} символов.` };
  if (findUserByLogin(login)) return { error: "Такой логин уже занят." };
  await createUser({ login, password, role: "supervisor", name: name || undefined });
  refresh();
  return { ok: `Руководитель ${login} создан.` };
}

export async function updateUserAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireHead();
  const id = str(form, "userId");
  const user = id ? findUserById(id) : null;
  if (!user) return { error: "Учётная запись не найдена." };
  const login = str(form, "login");
  const name = str(form, "name") || null;
  if (login.length < 2) return { error: "Логин слишком короткий." };
  // Logins are matched case-insensitively at sign-in, so check uniqueness the same way.
  const clash = findUserByLogin(login);
  if (clash && clash.id !== id) return { error: "Такой логин уже занят." };
  try {
    updateUser(id, { login, name });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: "Такой логин уже занят." };
    throw error;
  }
  refresh();
  return { ok: "Сохранено." };
}

export async function setUserPasswordAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireHead();
  const id = str(form, "userId");
  const password = str(form, "password");
  if (!id || !findUserById(id)) return { error: "Учётная запись не найдена." };
  if (password.length < MIN_PASSWORD) return { error: `Пароль не короче ${MIN_PASSWORD} символов.` };
  await setUserPassword(id, password);
  refresh();
  return { ok: "Пароль изменён; открытые сессии завершены." };
}

export async function setUserDisabledAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireHead();
  const id = str(form, "userId");
  const disabled = str(form, "disabled") === "1";
  const user = id ? findUserById(id) : null;
  if (!user) return { error: "Учётная запись не найдена." };
  // The head account is the only administrator: it can neither be disabled nor deleted.
  if (user.role === "head") return { error: "Учётную запись руководителя центра отключить нельзя." };
  setUserDisabled(id, disabled);
  refresh();
  return { ok: disabled ? "Учётная запись отключена." : "Учётная запись включена." };
}

export async function deleteUserAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireHead();
  const id = str(form, "userId");
  const user = id ? findUserById(id) : null;
  if (!user) return { error: "Учётная запись не найдена." };
  if (user.role === "head") return { error: "Учётную запись руководителя центра удалить нельзя." };
  if (str(form, "confirm") !== user.login) {
    return { error: `Для подтверждения введите логин ${user.login}.` };
  }
  deleteUser(id);
  refresh();
  redirect("/admin");
}
