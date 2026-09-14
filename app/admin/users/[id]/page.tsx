import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { findUserById, getViewer } from "@/lib/users";
import { listAllProjects, listProjectSupervisors } from "@/lib/curator/store";
import { deleteUserAction } from "@/app/actions/admin";
import { roleLabel } from "@/lib/format";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EditUserForm, SetPasswordForm, ToggleDisabledForm } from "@/components/admin/EditUserForm";
import { ConfirmDeleteForm } from "@/components/admin/ConfirmDeleteForm";

export const dynamic = "force-dynamic";

export default async function AdminUserPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.role !== "head") redirect("/");

  const user = findUserById((await params).id);
  if (!user) notFound();
  const isHeadAccount = user.role === "head";
  const isSelf = user.id === viewer.userId;

  const projects = listAllProjects().filter((p) => listProjectSupervisors(p.id).includes(user.id));

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <Link href="/admin" className="text-xs text-muted-foreground hover:text-foreground">
          ← Управление
        </Link>
        <div className="mt-2 mb-6 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{user.name ?? user.login}</h1>
          <Badge tone="primary">{roleLabel(user.role)}</Badge>
          {user.disabled && <Badge tone="neutral">отключена</Badge>}
          {isSelf && <span className="text-xs text-muted-foreground">это вы</span>}
        </div>

        <div className="flex flex-col gap-5">
          <Card className="shadow-card">
            <CardHeader>
              <CardTitle>Данные</CardTitle>
            </CardHeader>
            <CardBody>
              <EditUserForm user={user} />
            </CardBody>
          </Card>

          <Card className="shadow-card">
            <CardHeader>
              <CardTitle>Пароль</CardTitle>
            </CardHeader>
            <CardBody>
              <SetPasswordForm user={user} />
            </CardBody>
          </Card>

          {!isHeadAccount && (
            <Card className="shadow-card">
              <CardHeader>
                <CardTitle>Проекты</CardTitle>
              </CardHeader>
              <CardBody className="text-sm">
                {projects.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {projects.map((p) => (
                      <li key={p.id}>
                        <Link href={`/admin/projects/${p.id}`} className="hover:underline">
                          {p.name ?? p.repo}
                        </Link>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {p.owner}/{p.repo}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">Проекты не назначены.</p>
                )}
              </CardBody>
            </Card>
          )}

          {isHeadAccount ? (
            <p className="text-xs text-muted-foreground">
              Учётная запись руководителя центра — единственный администратор: её нельзя
              отключить или удалить. Если пароль утерян, его сбрасывают вручную в базе данных.
            </p>
          ) : (
            <>
              <Card className="shadow-card">
                <CardHeader>
                  <CardTitle>Доступ</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-3 text-sm">
                  <p className="text-muted-foreground">
                    {user.disabled
                      ? "Вход закрыт. Назначения на проекты сохранены."
                      : "Вход открыт. Отключение завершает открытые сессии и закрывает вход; назначения сохраняются."}
                  </p>
                  <ToggleDisabledForm user={user} />
                </CardBody>
              </Card>

              <Card className="border-red/40 shadow-card">
                <CardHeader>
                  <CardTitle className="text-red">Удалить учётную запись</CardTitle>
                </CardHeader>
                <CardBody>
                  <ConfirmDeleteForm
                    action={deleteUserAction}
                    hidden={{ userId: user.id }}
                    expected={user.login}
                    label="Удалить безвозвратно"
                  >
                    <p className="text-sm text-muted-foreground">
                      Назначения на проекты будут сняты; сами проекты и их память не затрагиваются.
                    </p>
                  </ConfirmDeleteForm>
                </CardBody>
              </Card>
            </>
          )}
        </div>
      </PageShell>
    </>
  );
}
