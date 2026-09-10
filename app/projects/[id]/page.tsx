import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/users";
import {
  getProject,
  getProjectParticipants,
  isSupervisorOf,
  listProjectAnalyses,
  listProjectFindings,
  type FindingRow,
} from "@/lib/curator/store";
import {
  findingStatusLabel,
  isOpenStatus,
  relativeDate,
  severityLabel,
} from "@/lib/format";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");

  const projectId = Number((await params).id);
  const project = getProject(projectId);
  if (!project || Number.isNaN(projectId)) notFound();
  if (viewer.role === "supervisor" && !isSupervisorOf(viewer.userId, projectId)) {
    notFound();
  }

  const participants = getProjectParticipants(projectId);
  const findings = listProjectFindings(projectId);
  const open = findings.filter((f) => isOpenStatus(f.status));
  const resolved = findings.filter((f) => !isOpenStatus(f.status));
  const analyses = listProjectAnalyses(projectId);

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <Link href="/" className="text-xs text-muted-foreground hover:text-foreground">
          ← К проектам
        </Link>
        <div className="mt-2 mb-6 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            {project.name ?? project.repo}
          </h1>
          {project.status === "paused" && <Badge tone="neutral">на паузе</Badge>}
          {project.status === "archived" && <Badge tone="neutral">в архиве</Badge>}
          <span className="text-sm text-muted-foreground">
            {project.owner}/{project.repo}
          </span>
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <div className="lg:col-span-2 flex flex-col gap-5">
            <FindingsSection
              title="Открытые замечания"
              findings={open}
              projectId={projectId}
              empty="Открытых замечаний нет."
            />
            <FindingsSection
              title="Закрытые и снятые"
              findings={resolved}
              projectId={projectId}
              empty="Пока ничего не закрыто."
            />
          </div>

          <div className="flex flex-col gap-5">
            <Card>
              <CardHeader>
                <CardTitle>Участники</CardTitle>
              </CardHeader>
              <CardBody className="text-sm">
                {participants.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {participants.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">Пока нет.</p>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Последние разборы</CardTitle>
              </CardHeader>
              <CardBody>
                {analyses.length > 0 ? (
                  <ul className="flex flex-col gap-3 text-sm">
                    {analyses.map((a) => (
                      <li key={a.id} className="flex flex-col gap-0.5">
                        <span className="text-xs text-muted-foreground">
                          {a.prNumber ? `PR #${a.prNumber}` : "—"} · {relativeDate(a.createdAt)}
                        </span>
                        <span className="text-foreground">
                          {a.summary ?? (a.outcome === "ok" ? "Разбор выполнен" : a.outcome)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">Разборов пока не было.</p>
                )}
              </CardBody>
            </Card>
          </div>
        </div>
      </PageShell>
    </>
  );
}

function FindingsSection({
  title,
  findings,
  projectId,
  empty,
}: {
  title: string;
  findings: FindingRow[];
  projectId: number;
  empty: string;
}) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>{title}</CardTitle>
        <span className="text-xs text-muted-foreground">{findings.length}</span>
      </CardHeader>
      <CardBody className="pt-0">
        {findings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {findings.map((f) => (
              <li key={f.id} className="py-3 first:pt-0 last:pb-0">
                <Link
                  href={`/projects/${projectId}/findings/${f.id}`}
                  className="group flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium group-hover:underline">{f.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {f.category ?? "без категории"}
                      {f.file ? ` · ${f.file}` : ""}
                      {f.prNumber ? ` · PR #${f.prNumber}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <FindingStatusBadge f={f} />
                    <span className="text-xs text-muted-foreground">
                      {relativeDate(f.updatedAt)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function FindingStatusBadge({ f }: { f: FindingRow }) {
  const tone =
    f.status === "open" || f.status === "reopened"
      ? severityLabel(f.severity) === "высокая"
        ? "red"
        : "amber"
      : f.status === "pending"
        ? "amber"
        : "green";
  return <Badge tone={tone}>{findingStatusLabel(f.status)}</Badge>;
}

