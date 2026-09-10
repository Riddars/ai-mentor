import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/users";
import {
  getFinding,
  getFindingHistory,
  getFindingResponses,
  getProject,
  isSupervisorOf,
} from "@/lib/curator/store";
import { findingStatusLabel, fullDate, severityLabel } from "@/lib/format";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";

export const dynamic = "force-dynamic";

export default async function FindingPage({
  params,
}: {
  params: Promise<{ id: string; fid: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");

  const { id, fid } = await params;
  const projectId = Number(id);
  const finding = getFinding(Number(fid));
  if (!finding || finding.projectId !== projectId) notFound();
  if (viewer.role === "supervisor" && !isSupervisorOf(viewer.userId, projectId)) {
    notFound();
  }

  const project = getProject(projectId);
  const history = getFindingHistory(finding.id);
  const responses = getFindingResponses(finding.id);
  const serious = severityLabel(finding.severity) === "высокая";

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <Link
          href={`/projects/${projectId}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← {project?.name ?? project?.repo ?? "К проекту"}
        </Link>

        <div className="mt-2 mb-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={serious ? "red" : "amber"}>
              серьёзность: {severityLabel(finding.severity)}
            </Badge>
            <Badge tone="neutral">{finding.category ?? "без категории"}</Badge>
            <Badge
              tone={
                finding.status === "closed" || finding.status === "dismissed"
                  ? "green"
                  : serious
                    ? "red"
                    : "amber"
              }
            >
              {findingStatusLabel(finding.status)}
            </Badge>
          </div>
          <h1 className="mt-3 text-xl font-semibold tracking-tight">{finding.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {finding.prNumber ? `PR #${finding.prNumber} · ` : ""}обнаружено{" "}
            {fullDate(finding.createdAt)}
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <div className="lg:col-span-2 flex flex-col gap-5">
            <Field title="Место обнаружения">
              {finding.file ? (
                <code className="text-sm">
                  {finding.file}
                  {finding.lines ? `:${finding.lines}` : ""}
                </code>
              ) : (
                <Muted>Не указано.</Muted>
              )}
            </Field>
            <Field title="Подтверждение">
              <Text value={finding.evidence} />
            </Field>
            <Field title="Влияние на результаты">
              <Text value={finding.impact} />
            </Field>
            <Field title="Рекомендуемое исправление">
              <Text value={finding.recommendation} />
            </Field>
            {responses.length > 0 && (
              <Field title="Ответ студента">
                <ul className="flex flex-col gap-3">
                  {responses.map((r, i) => (
                    <li key={i} className="text-sm">
                      <span className="text-xs text-muted-foreground">
                        {r.login ?? "студент"} · {fullDate(r.createdAt)}
                      </span>
                      <p className="mt-0.5 whitespace-pre-wrap">{r.body}</p>
                    </li>
                  ))}
                </ul>
              </Field>
            )}
          </div>

          <Card className="h-fit">
            <CardHeader>
              <CardTitle>История статуса</CardTitle>
            </CardHeader>
            <CardBody>
              {history.length > 0 ? (
                <ol className="flex flex-col gap-4">
                  {history.map((h, i) => (
                    <li key={i} className="relative pl-4">
                      <span className="absolute left-0 top-1.5 size-2 rounded-full bg-primary" />
                      <p className="text-sm font-medium">
                        {h.oldStatus
                          ? `${findingStatusLabel(h.oldStatus as never)} → ${findingStatusLabel(h.newStatus as never)}`
                          : findingStatusLabel(h.newStatus as never)}
                      </p>
                      <p className="text-xs text-muted-foreground">{fullDate(h.createdAt)}</p>
                      {h.reason && <p className="mt-1 text-xs">{h.reason}</p>}
                    </li>
                  ))}
                </ol>
              ) : (
                <Muted>Изменений статуса не было.</Muted>
              )}
            </CardBody>
          </Card>
        </div>
      </PageShell>
    </>
  );
}

function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Text({ value }: { value: string | null }) {
  if (!value) return <Muted>Не указано.</Muted>;
  return <p className="text-sm whitespace-pre-wrap">{value}</p>;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
