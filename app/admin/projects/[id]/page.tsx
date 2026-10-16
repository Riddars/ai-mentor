import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer, listUsers } from "@/lib/users";
import {
  getProject,
  isSupervisorOf,
  listProjectSupervisors,
  projectHasPullRequests,
  upsertParticipant,
} from "@/lib/curator/store";
import {
  assignSupervisorAction,
  deleteProjectAction,
  setProjectStatusAction,
  unassignSupervisorAction,
} from "@/app/actions/admin";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EditProjectForm } from "@/components/admin/EditProjectForm";
import { ConfirmDeleteForm } from "@/components/admin/ConfirmDeleteForm";
import { getConfig } from "@/lib/config";
import { checkRepositorySetup, type RepositorySetup } from "@/lib/github/setup";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AdminProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  const isHead = viewer.role === "head";

  const id = Number((await params).id);
  const project = Number.isNaN(id) ? null : getProject(id);
  if (!project || (!isHead && !isSupervisorOf(viewer.userId, id))) notFound();

  const users = isHead ? listUsers() : [];
  const assignedIds = new Set(listProjectSupervisors(id));
  const assigned = users.filter((u) => assignedIds.has(u.id));
  const available = users.filter(
    (u) => u.role === "supervisor" && !u.disabled && !assignedIds.has(u.id),
  );
  const hasPrs = projectHasPullRequests(id);
  const fullName = `${project.owner}/${project.repo}`;
  const repoUrl = `https://github.com/${fullName}`;
  let setup: RepositorySetup | null = null;
  try {
    setup = await checkRepositorySetup(project.owner, project.repo, getConfig().appId);
  } catch (error) {
    console.warn(`[panel] setup of ${fullName} not checked:`, error);
  }
  // Students who joined while the service missed the event become participants here.
  for (const login of setup?.students ?? []) upsertParticipant(id, login);

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <Breadcrumbs
          items={[{ label: "Управление", href: "/admin" }, { label: project.name ?? project.repo }]}
        />
        <div className="mt-2 mb-6 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{project.name ?? project.repo}</h1>
          <Badge tone={project.status === "active" ? "green" : "neutral"}>
            {project.status === "active" ? "активен" : "на паузе"}
          </Badge>
          <Link href={`/projects/${id}`} className="text-sm text-muted-foreground hover:underline">
            Открыть в панели
          </Link>
        </div>

        <div className="flex flex-col gap-5">
          <Card className="shadow-card">
            <CardHeader>
              <CardTitle>Данные проекта</CardTitle>
            </CardHeader>
            <CardBody>
              <EditProjectForm
                project={{ id: project.id, owner: project.owner, repo: project.repo, name: project.name }}
                canRename={!hasPrs}
              />
            </CardBody>
          </Card>

          {isHead && (
          <Card className="shadow-card">
            <CardHeader>
              <CardTitle>Руководители</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {assigned.length > 0 ? (
                  assigned.map((u) => (
                    <form key={u.id} action={unassignSupervisorAction} className="contents">
                      <input type="hidden" name="projectId" value={id} />
                      <input type="hidden" name="userId" value={u.id} />
                      <button
                        type="submit"
                        className="inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-xs text-accent-foreground hover:opacity-80"
                        title="Снять назначение"
                      >
                        {u.name ?? u.login} <span aria-hidden>✕</span>
                      </button>
                    </form>
                  ))
                ) : (
                  <span className="text-sm text-amber">Руководитель не назначен.</span>
                )}
              </div>
              {available.length > 0 && (
                <form action={assignSupervisorAction} className="flex items-center gap-2">
                  <input type="hidden" name="projectId" value={id} />
                  <select
                    name="userId"
                    defaultValue=""
                    className="h-8 rounded-md border border-border bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="" disabled>
                      назначить…
                    </option>
                    {available.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name ? `${u.name} (${u.login})` : u.login}
                      </option>
                    ))}
                  </select>
                  <Button variant="outline" size="sm" type="submit">
                    Назначить
                  </Button>
                </form>
              )}
            </CardBody>
          </Card>
          )}

          <Card className="shadow-card">
            <CardHeader className="flex items-center justify-between gap-3">
              <CardTitle>Подготовка репозитория</CardTitle>
              <Link href={`/admin/projects/${id}`} className="text-xs text-muted-foreground hover:underline">
                Обновить
              </Link>
            </CardHeader>
            <CardBody className="flex flex-col gap-5 pt-0 text-sm">
              <p className="text-muted-foreground">
                Чтобы куратор проверял работу студентов, в репозитории на GitHub нужно сделать два шага.
              </p>
              {setup === null && <p className="text-amber">Не удалось связаться с GitHub — попробуйте обновить позже.</p>}
              {setup?.installed === false && (
                <p className="text-red">Куратор не видит репозиторий. Проверьте, что он создан в организации проектов.</p>
              )}
              {setup?.isPublic === false && (
                <p className="text-red">Репозиторий закрытый — куратор работает только с публичными.</p>
              )}

              <SetupStep
                n={1}
                title="Защитите основную ветку"
                done={setup ? Boolean(setup.pullRequestsOnly && setup.checkRequired) : null}
                doneText="Готово: изменения попадают в проект только через pull request с проверкой куратора."
              >
                <ol className="flex list-decimal flex-col gap-1 pl-5">
                  <li>
                    <a href="/api/ruleset" download className="font-medium text-primary hover:underline">
                      Скачайте файл настройки
                    </a>
                    .
                  </li>
                  <li>
                    Откройте{" "}
                    <a href={`${repoUrl}/settings/rules`} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                      настройки репозитория
                    </a>
                    , нажмите <b>New ruleset</b> → <b>Import a ruleset</b> и выберите скачанный файл.
                  </li>
                  <li>
                    Внизу страницы нажмите <b>Create</b>.
                  </li>
                </ol>
              </SetupStep>

              <SetupStep
                n={2}
                title="Пригласите студентов"
                note="Смотреть публичный репозиторий может любой, а вносить изменения — только приглашённые."
                done={setup?.students?.length ? true : setup ? false : null}
                doneText={`В репозитории: ${setup?.students?.join(", ") ?? ""}.`}
                keepInstructions
              >
                <ol className="flex list-decimal flex-col gap-1 pl-5">
                  <li>
                    Откройте в GitHub{" "}
                    <a href={`${repoUrl}/settings/access`} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                      список участников репозитория
                    </a>{" "}
                    (Collaborators) и нажмите зелёную кнопку <b>Add people</b>.
                  </li>
                  <li>Введите логин студента на GitHub или его почту и выберите его в списке.</li>
                  <li>
                    Выберите роль <b>Write</b> и нажмите <b>Add to repository</b>.
                  </li>
                </ol>
                <p className="mt-1 text-xs text-muted-foreground">
                  Студенту придёт приглашение на почту; здесь он появится, когда его примет.
                </p>
              </SetupStep>
            </CardBody>
          </Card>

          <Card className="shadow-card">
            <CardHeader>
              <CardTitle>Состояние</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3 text-sm">
              <p className="text-muted-foreground">
                {project.status === "active"
                  ? "Проект в работе: pull requests разбираются."
                  : "Проект на паузе: pull requests не разбираются, обязательная проверка завершается сразу с пометкой о паузе. Накопленные замечания сохраняются."}
              </p>
              <form action={setProjectStatusAction}>
                <input type="hidden" name="projectId" value={id} />
                <input type="hidden" name="status" value={project.status === "active" ? "paused" : "active"} />
                <Button variant="outline" size="sm" type="submit">
                  {project.status === "active" ? "Поставить на паузу" : "Возобновить"}
                </Button>
              </form>
            </CardBody>
          </Card>

          {isHead && (
          <Card className="border-red/40 shadow-card">
            <CardHeader>
              <CardTitle className="text-red">Удалить проект</CardTitle>
            </CardHeader>
            <CardBody>
              <ConfirmDeleteForm
                action={deleteProjectAction}
                hidden={{ projectId: id }}
                expected={fullName}
                label="Удалить безвозвратно"
              >
                <p className="text-sm text-muted-foreground">
                  Удаляется всё, что система помнит о проекте: pull requests, разборы,
                  замечания, история и ответы студентов. Удалённый проект не подключается
                  заново автоматически. Для завершённых проектов используйте паузу.
                </p>
              </ConfirmDeleteForm>
            </CardBody>
          </Card>
          )}
        </div>
      </PageShell>
    </>
  );
}

/** One step of preparing the repository: what to do, or that it is done (null — unknown). */
function SetupStep({
  n,
  title,
  done,
  doneText,
  note,
  keepInstructions,
  children,
}: {
  n: number;
  title: string;
  done: boolean | null;
  doneText: string;
  note?: string;
  /** Instructions stay after the step is done: it may be repeated (more students). */
  keepInstructions?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="flex gap-3">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          done ? "bg-green-soft text-green" : "bg-muted text-muted-foreground",
        )}
      >
        {done ? "✓" : n}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="font-medium">{title}</p>
        {note && !done && <p className="text-muted-foreground">{note}</p>}
        {done && <p className="text-green">{doneText}</p>}
        {(!done || keepInstructions) && children}
      </div>
    </section>
  );
}
