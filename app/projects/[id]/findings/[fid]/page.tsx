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
import type { FindingLocation } from "@/lib/curator/finding";
import {
  areaLabel,
  findingStatusLabel,
  fullDate,
  isOpenStatus,
  locationText,
  prStateLabel,
} from "@/lib/format";
import { FindingDecisionForm } from "@/components/FindingDecisionForm";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Breadcrumbs } from "@/components/Breadcrumbs";
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
  if (!project) notFound();
  const repoUrl = `https://github.com/${project.owner}/${project.repo}`;
  const history = getFindingHistory(finding.id);
  // A finding raised in one PR may be fixed or dismissed by a later one.
  const lastChange = history.at(-1);
  const fixedIn =
    (finding.status === "closed" || finding.status === "pending") &&
    finding.resolvedByPrNumber !== null &&
    finding.resolvedByPrNumber !== finding.prNumber
      ? finding.resolvedByPrNumber
      : null;
  const dismissedIn =
    finding.status === "dismissed" &&
    lastChange?.analysisId &&
    lastChange.prNumber !== null &&
    lastChange.prNumber !== finding.prNumber
      ? { analysisId: lastChange.analysisId, prNumber: lastChange.prNumber }
      : null;
  // Student replies are recorded per pull request, not per finding.
  const responses = loadStudentResponses(finding.pullRequestId);
  // Same tones as the project page: closed = green, dismissed = amber (a human
  // still checks the model's decision), reopened = red.
  const statusTone =
    finding.status === "closed"
      ? "green"
      : finding.status === "reopened"
        ? "red"
        : finding.status === "dismissed" || finding.status === "pending"
          ? "amber"
          : "neutral";

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <Breadcrumbs
          items={[
            { label: "Проекты", href: "/" },
            { label: project.name ?? project.repo, href: `/projects/${projectId}` },
            { label: "Замечание" },
          ]}
        />

        <div className="mt-2 mb-6">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={finding.severity} />
            <Badge tone="primary">{areaLabel(finding.area)}</Badge>
            <Badge tone={statusTone}>{findingStatusLabel(finding.status)}</Badge>
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">{finding.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {finding.prNumber ? (
              <>
                <a
                  href={`${repoUrl}/pull/${finding.prNumber}`}
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
            {fixedIn !== null && (
              <>
                {" · исправлено в "}
                <a href={`${repoUrl}/pull/${fixedIn}`} target="_blank" rel="noreferrer" className="hover:underline">
                  PR #{fixedIn}
                </a>
                {finding.status === "pending" && ", ждёт слияния"}
              </>
            )}
            {dismissedIn && (
              <>
                {" · снято в "}
                <Link
                  href={`/projects/${projectId}/analyses/${dismissedIn.analysisId}`}
                  className="hover:underline"
                >
                  PR #{dismissedIn.prNumber}
                </Link>
              </>
            )}
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <div className="flex flex-col gap-5 lg:col-span-2">
            {finding.description && (
              <Field title="Что не так">
                <Text value={finding.description} />
              </Field>
            )}
            {finding.impact && (
              <Field title="Почему это важно">
                <Text value={finding.impact} />
              </Field>
            )}
            {(finding.locations.length > 0 || finding.evidence) && (
              <Field title="Основания">
                <div className="flex flex-col gap-2">
                  {finding.locations.length > 0 && (
                    <ul className="flex flex-col gap-1 text-sm">
                      {finding.locations.map((l, i) => (
                        <li key={i}>
                          <Location location={l} repoUrl={repoUrl} sha={finding.headSha} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {finding.evidence && (
                    <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap">
                      <code>{finding.evidence}</code>
                    </pre>
                  )}
                </div>
              </Field>
            )}
            {finding.recommendation && (
              <Field title="Что сделать">
                <Text value={finding.recommendation} />
              </Field>
            )}
            {finding.verify && (
              <Field title="Как проверить исправление">
                <Text value={finding.verify} />
              </Field>
            )}
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

          <div className="flex h-fit flex-col gap-5">
            {history.length > 0 && (
              <Card className="shadow-card">
                <CardHeader>
                  <CardTitle>История статуса</CardTitle>
                </CardHeader>
                <CardBody>
                  <ol className="flex flex-col gap-4">
                    {history.map((h, i) => (
                      <li key={i} className="relative pl-5">
                        <span className="absolute top-1 left-0 flex size-3 items-center justify-center">
                          <span className="size-2 rounded-full bg-primary" />
                        </span>
                        {i < history.length - 1 && (
                          <span className="absolute top-4 left-1.5 h-full w-px bg-border" />
                        )}
                        <p className="text-sm font-medium">{findingStatusLabel(h.newStatus)}</p>
                        <p className="text-xs text-muted-foreground">
                          {h.analysisId && h.prNumber ? (
                            <>
                              <Link
                                href={`/projects/${projectId}/analyses/${h.analysisId}`}
                                className="hover:text-foreground hover:underline"
                              >
                                PR #{h.prNumber}
                              </Link>
                              {" · "}
                            </>
                          ) : null}
                          {fullDate(h.createdAt)}
                          {h.actor && ` · решение: ${h.actor}`}
                        </p>
                        {h.reason && <p className="mt-1 text-xs">{h.reason}</p>}
                      </li>
                    ))}
                  </ol>
                </CardBody>
              </Card>
            )}
            <Card className="shadow-card">
              <CardHeader>
                <CardTitle>Решение руководителя</CardTitle>
              </CardHeader>
              <CardBody className="pt-0">
                <FindingDecisionForm findingId={finding.id} isOpen={isOpenStatus(finding.status)} />
              </CardBody>
            </Card>
          </div>
        </div>
      </PageShell>
    </>
  );
}

/** "42-58" → "#L42-L58"; anything else has no line anchor. */
function lineAnchor(detail: string | null | undefined): string {
  const m = detail?.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) return "";
  return m[2] ? `#L${m[1]}-L${m[2]}` : `#L${m[1]}`;
}

function Location({
  location,
  repoUrl,
  sha,
}: {
  location: FindingLocation;
  repoUrl: string;
  sha: string | null;
}) {
  const text = locationText(location);
  if (location.kind === "other") return <span>{text}</span>;
  const code = <code className="rounded bg-muted px-1.5 py-0.5 text-[0.8rem]">{text}</code>;
  if (location.kind === "data" || !sha) return code;
  const anchor = location.kind === "file" ? lineAnchor(location.detail) : "";
  return (
    <a
      href={`${repoUrl}/blob/${sha}/${location.target}${anchor}`}
      target="_blank"
      rel="noreferrer"
      className="hover:underline"
    >
      {code}
    </a>
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

function Text({ value }: { value: string }) {
  return <p className="text-sm leading-relaxed whitespace-pre-wrap">{value}</p>;
}
