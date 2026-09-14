import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer, listUsers } from "@/lib/users";
import { listAllProjects, listProjectSupervisors } from "@/lib/curator/store";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { AddProjectForm } from "@/components/admin/AddProjectForm";
import { CreateSupervisorForm } from "@/components/admin/CreateSupervisorForm";
import { roleLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.role !== "head") redirect("/");

  const projects = listAllProjects();
  const users = listUsers();
  const byId = new Map(users.map((u) => [u.id, u]));

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Управление</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Подключение репозиториев, состояние проектов и учётные записи. Разбираются
            только подключённые здесь проекты.
          </p>
        </div>

        <div className="flex flex-col gap-6">
          <Card className="shadow-card">
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Проекты</CardTitle>
              <span className="text-xs text-muted-foreground">{projects.length}</span>
            </CardHeader>
            <CardBody className="flex flex-col gap-5">
              <AddProjectForm />
              {projects.length > 0 && (
                <ul className="flex flex-col divide-y divide-border">
                  {projects.map((p) => {
                    const supervisors = listProjectSupervisors(p.id)
                      .map((id) => byId.get(id))
                      .filter((u) => u !== undefined)
                      .map((u) => u.login);
                    return (
                      <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Link href={`/admin/projects/${p.id}`} className="font-medium hover:underline">
                              {p.name ?? p.repo}
                            </Link>
                            {p.status === "paused" && <Badge tone="neutral">пауза</Badge>}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {p.owner}/{p.repo}
                            {" · "}
                            {supervisors.length > 0 ? supervisors.join(", ") : (
                              <span className="text-amber">руководитель не назначен</span>
                            )}
                          </div>
                        </div>
                        <Link href={`/admin/projects/${p.id}`} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
                          изменить →
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card className="shadow-card">
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Учётные записи</CardTitle>
              <span className="text-xs text-muted-foreground">{users.length}</span>
            </CardHeader>
            <CardBody className="flex flex-col gap-5">
              <CreateSupervisorForm />
              <ul className="flex flex-col divide-y divide-border">
                {users.map((u) => (
                  <li key={u.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Link href={`/admin/users/${u.id}`} className="font-medium hover:underline">
                          {u.login}
                        </Link>
                        {u.name && <span className="text-xs text-muted-foreground">{u.name}</span>}
                        {u.disabled && <Badge tone="neutral">отключена</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground">{roleLabel(u.role)}</div>
                    </div>
                    <Link href={`/admin/users/${u.id}`} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
                      изменить →
                    </Link>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      </PageShell>
    </>
  );
}
