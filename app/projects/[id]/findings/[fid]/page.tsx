import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/users";
import {
  getFinding,
  getFindingHistory,
  getProject,
  isSupervisorOf,
  loadStudentResponses,
} from "@/lib/curator/store";
import { categoryLabel, findingStatusLabel, fullDate, prStateLabel } from "@/lib/format";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Badge, SeverityBadge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";

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
  // Student replies are recorded per pull request, not per finding.
  const responses = loadStudentResponses(finding.pullRequestId);
  // Same tones as the project page: closed = green, dismissed = neutral (a human
  // still checks it), reopened = red.
  const statusTone =
    finding.status === "closed"
      ? "green"
      : finding.status === "reopened"
        ? "red"
        : finding.status === "pending"
          ? "amber"
          : "neutral";

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
            <SeverityBadge severity={finding.severity} />
            <Badge tone="primary">{categoryLabel(finding.category)}</Badge>
            <Badge tone={statusTone}>{findingStatusLabel(finding.status)}</Badge>
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">{finding.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {finding.prNumber ? (
              <>
                <a
                  href={`https://github.com/${project?.owner}/${project?.repo}/pull/${finding.prNumber}`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  PR #{finding.prNumber}
                </a>
                {finding.prState && finding.prState !== "open" ? ` (${prStateLabel(finding.prState)})` : ""}
                {" · "}
              </>
            ) : null}
            обнаружено {fullDate(finding.createdAt)}
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <div className="flex flex-col gap-5 lg:col-span-2">
            <Field title="Место обнаружения">
              {finding.file ? (
                <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
                  <code>
                    {finding.file}
                    {finding.lines ? `:${finding.lines}` : ""}
                  </code>
                </pre>
              ) : (
                <Muted>Не указано.</Muted>
              )}
            </Field>
            <Field title="Подтверждение">
              <Evidence value={finding.evidence} />
            </Field>
            <Field title="Влияние на результаты">
              <Text value={finding.impact} />
            </Field>
            <Field title="Рекомендуемое исправление">
              <Text value={finding.recommendation} />
            </Field>
            {responses.length > 0 && (
              <Field title="Ответы студента в pull request">
                <ul className="flex flex-col gap-4">
                  {responses.map((r, i) => (
                    <li key={i} className="rounded-lg border border-border bg-card p-3 shadow-card">
                      <div className="mb-1.5 flex items-center gap-2">
                        <Avatar handle={r.login ?? "студент"} size="sm" />
                        <span className="text-sm font-medium">{r.login ?? "студент"}</span>
                        <span className="text-xs text-muted-foreground">{fullDate(r.createdAt)}</span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap">{r.body}</p>
                    </li>
                  ))}
                </ul>
              </Field>
            )}
          </div>

          <Card className="h-fit shadow-card">
            <CardHeader>
              <CardTitle>История статуса</CardTitle>
            </CardHeader>
            <CardBody>
              {history.length > 0 ? (
                <ol className="flex flex-col gap-4">
                  {history.map((h, i) => (
                    <li key={i} className="relative pl-5">
                      <span className="absolute top-1 left-0 flex size-3 items-center justify-center">
                        <span className="size-2 rounded-full bg-primary" />
                      </span>
                      {i < history.length - 1 && (
                        <span className="absolute top-4 left-1.5 h-full w-px bg-border" />
                      )}
                      <p className="text-sm font-medium">
                        {h.oldStatus
                          ? `${findingStatusLabel(h.oldStatus)} → ${findingStatusLabel(h.newStatus)}`
                          : findingStatusLabel(h.newStatus)}
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
      <h2 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Text({ value }: { value: string | null }) {
  if (!value) return <Muted>Не указано.</Muted>;
  return <p className="text-sm leading-relaxed whitespace-pre-wrap">{value}</p>;
}

function Evidence({ value }: { value: string | null }) {
  if (!value) return <Muted>Не указано.</Muted>;
  return (
    <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap">
      <code>{value}</code>
    </pre>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
