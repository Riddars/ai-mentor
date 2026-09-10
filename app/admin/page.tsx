import { redirect } from "next/navigation";
import { getViewer, listUsers, type User } from "@/lib/users";
import {
  listAllProjects,
  listProjectSupervisors,
  type ProjectDetail,
  type ProjectStatus,
} from "@/lib/curator/store";
import {
  assignSupervisorAction,
  setProjectStatusAction,
  setUserDisabledAction,
  unassignSupervisorAction,
} from "@/app/actions/admin";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { AddProjectForm } from "@/components/admin/AddProjectForm";
import { CreateSupervisorForm } from "@/components/admin/CreateSupervisorForm";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: "активен",
  paused: "на паузе",
  archived: "в архиве",
};

export default async function AdminPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.role !== "head") redirect("/");

  const projects = listAllProjects();
  const users = listUsers();
  const supervisors = users.filter((u) => u.role === "supervisor");
  const byId = new Map(users.map((u) => [u.id, u]));

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <h1 className="mb-6 text-xl font-semibold tracking-tight">Управление</h1>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Подключить репозиторий</CardTitle>
            </CardHeader>
            <CardBody>
              <AddProjectForm />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Проекты</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              {projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">Проектов пока нет.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {projects.map((p) => (
                    <ProjectAdminRow
                      key={p.id}
                      project={p}
                      assigned={listProjectSupervisors(p.id)
                        .map((uid) => byId.get(uid))
                        .filter((u): u is User => Boolean(u))}
                      supervisors={supervisors}
                    />
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Руководители проектов</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-5">
              <CreateSupervisorForm />
              {supervisors.length > 0 && (
                <ul className="flex flex-col divide-y divide-border">
                  {supervisors.map((u) => (
                    <li key={u.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div>
                        <span className="text-sm font-medium">{u.login}</span>
                        {u.name && (
                          <span className="ml-2 text-xs text-muted-foreground">{u.name}</span>
                        )}
                        {u.disabled && (
                          <Badge tone="neutral" className="ml-2">
                            отключён
                          </Badge>
                        )}
                      </div>
                      <form action={setUserDisabledAction}>
                        <input type="hidden" name="userId" value={u.id} />
                        <input type="hidden" name="disabled" value={u.disabled ? "0" : "1"} />
                        <Button variant="outline" size="sm" type="submit">
                          {u.disabled ? "Включить" : "Отключить"}
                        </Button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </PageShell>
    </>
  );
}

function ProjectAdminRow({
  project,
  assigned,
  supervisors,
}: {
  project: ProjectDetail;
  assigned: User[];
  supervisors: User[];
}) {
  const assignedIds = new Set(assigned.map((u) => u.id));
  const available = supervisors.filter((u) => !assignedIds.has(u.id) && !u.disabled);

  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{project.name ?? project.repo}</span>
          <Badge tone={project.status === "active" ? "green" : "neutral"}>
            {STATUS_LABEL[project.status]}
          </Badge>
        </div>
        <div className="text-xs text-muted-foreground">
          {project.owner}/{project.repo}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {assigned.length > 0 ? (
            assigned.map((u) => (
              <form key={u.id} action={unassignSupervisorAction} className="contents">
                <input type="hidden" name="projectId" value={project.id} />
                <input type="hidden" name="userId" value={u.id} />
                <button
                  type="submit"
                  className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground hover:opacity-80"
                  title="Снять назначение"
                >
                  {u.login} <span aria-hidden>✕</span>
                </button>
              </form>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">руководитель не назначен</span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {available.length > 0 && (
          <form action={assignSupervisorAction} className="flex items-center gap-1.5">
            <input type="hidden" name="projectId" value={project.id} />
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
                  {u.login}
                </option>
              ))}
            </select>
            <Button variant="outline" size="sm" type="submit">
              Назначить
            </Button>
          </form>
        )}
        <StatusControls project={project} />
      </div>
    </li>
  );
}

function StatusControls({ project }: { project: ProjectDetail }) {
  const targets: { status: ProjectStatus; label: string }[] = [
    { status: "active", label: "Активен" },
    { status: "paused", label: "Пауза" },
    { status: "archived", label: "Архив" },
  ];
  return (
    <div className="flex items-center gap-1">
      {targets
        .filter((t) => t.status !== project.status)
        .map((t) => (
          <form key={t.status} action={setProjectStatusAction}>
            <input type="hidden" name="projectId" value={project.id} />
            <input type="hidden" name="status" value={t.status} />
            <Button variant="ghost" size="sm" type="submit">
              {t.label}
            </Button>
          </form>
        ))}
    </div>
  );
}
