import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer, listUsers } from "@/lib/users";
import {
  getProject,
  listProjectSupervisors,
  projectHasPullRequests,
} from "@/lib/curator/store";
import {
  assignSupervisorAction,
  deleteProjectAction,
  setProjectStatusAction,
  unassignSupervisorAction,
} from "@/app/actions/admin";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EditProjectForm } from "@/components/admin/EditProjectForm";
import { ConfirmDeleteForm } from "@/components/admin/ConfirmDeleteForm";

export const dynamic = "force-dynamic";

export default async function AdminProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.role !== "head") redirect("/");

  const id = Number((await params).id);
  const project = Number.isNaN(id) ? null : getProject(id);
  if (!project) notFound();

  const users = listUsers();
  const assignedIds = new Set(listProjectSupervisors(id));
  const assigned = users.filter((u) => assignedIds.has(u.id));
  const available = users.filter(
    (u) => u.role === "supervisor" && !u.disabled && !assignedIds.has(u.id),
  );
  const hasPrs = projectHasPullRequests(id);
  const fullName = `${project.owner}/${project.repo}`;

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <Link href="/admin" className="text-xs text-muted-foreground hover:text-foreground">
          ← Управление
        </Link>
        <div className="mt-2 mb-6 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{project.name ?? project.repo}</h1>
          <Badge tone={project.status === "active" ? "green" : "neutral"}>
            {project.status === "active" ? "активен" : "на паузе"}
          </Badge>
          <Link href={`/projects/${id}`} className="text-sm text-muted-foreground hover:underline">
            открыть в панели →
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
        </div>
      </PageShell>
    </>
  );
}
