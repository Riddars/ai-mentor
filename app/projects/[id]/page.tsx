import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer, listUsers } from "@/lib/users";
import {
  getProject,
  getProjectLastActivity,
  getProjectParticipants,
  isSupervisorOf,
  listProjectAnalyses,
  listProjectFindings,
  listProjectSupervisors,
  listUnreviewedPrs,
  type AnalysisRow,
  type FindingRow,
} from "@/lib/curator/store";
import {
  areaLabel,
  findingStatusLabel,
  isOpenStatus,
  outcomeLabel,
  relativeDate,
  severityRank,
  triggerLabel,
} from "@/lib/format";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Badge, SeverityBadge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { CollapsibleCard } from "@/components/ui/Collapsible";
import { RestartReviewButton } from "@/components/RestartReviewButton";
import { cn } from "@/lib/utils";

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
  const isHead = viewer.role === "head";

  const participants = getProjectParticipants(projectId);
  const findings = listProjectFindings(projectId);
  const analyses = listProjectAnalyses(projectId);
  const unreviewed = listUnreviewedPrs(projectId);
  const lastActivity = getProjectLastActivity(projectId);
  const supervisors = isHead
    ? (() => {
        const ids = new Set(listProjectSupervisors(projectId));
        return listUsers().filter((u) => ids.has(u.id)).map((u) => u.name ?? u.login);
      })()
    : [];

  // "Open" means open for the project: findings in PRs closed without merge never
  // reached the main branch and are listed apart (see принятые решения.md).
  const open = findings
    .filter((f) => isOpenStatus(f.status) && f.prState !== "closed")
    .sort(compareOpen);
  const openInClosedPr = findings.filter((f) => isOpenStatus(f.status) && f.prState === "closed");
  const dismissed = findings.filter((f) => f.status === "dismissed");
  const closed = findings.filter((f) => f.status === "closed");

  const title = project.name ?? project.repo;

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <Breadcrumbs items={[{ label: "Проекты", href: "/" }, { label: title }]} />
        <div className="mt-2 mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {project.status === "paused" && <Badge tone="neutral">на паузе</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <a
              href={`https://github.com/${project.owner}/${project.repo}`}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground hover:underline"
            >
              {project.owner}/{project.repo}
            </a>
            <span>Участники: {participants.length > 0 ? participants.join(", ") : "—"}</span>
            {isHead && (
              <span>
                Руководитель:{" "}
                {supervisors.length > 0 ? supervisors.join(", ") : <span className="text-amber">не назначен</span>}
              </span>
            )}
            <span>Последняя активность: {relativeDate(lastActivity)}</span>
          </div>
        </div>

        <div className="flex flex-col gap-5">
          {unreviewed.length > 0 && (
            <Card className="shadow-card">
              <CardHeader className="flex items-center justify-between">
                <CardTitle>Не разобраны</CardTitle>
                <span className="text-xs text-muted-foreground">{unreviewed.length}</span>
              </CardHeader>
              <CardBody className="pt-0">
                <ul className="flex flex-col divide-y divide-border text-sm">
                  {unreviewed.map((u) => (
                    <li key={u.prId} className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span>
                        <span className="font-medium">PR #{u.number}</span>
                        <span className="text-muted-foreground"> · {unreviewedReason(u.status, u.note)}</span>
                      </span>
                      <RestartReviewButton prId={u.prId} />
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}
          <Card className="shadow-card">
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Открытые замечания</CardTitle>
              <span className="text-xs text-muted-foreground">{open.length}</span>
            </CardHeader>
            <CardBody className="pt-0">
              {open.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">Открытых замечаний нет.</p>
              ) : (
                <FindingList findings={open} projectId={projectId} />
              )}
            </CardBody>
          </Card>

          {dismissed.length + closed.length > 0 && (
            <CollapsibleCard title="Закрытые замечания" count={dismissed.length + closed.length}>
              <div className="flex flex-col gap-5">
                {dismissed.length > 0 && (
                  <FindingGroup title="Сняты по объяснению студента" tone="amber">
                    <FindingList findings={dismissed} projectId={projectId} closed />
                  </FindingGroup>
                )}
                {closed.length > 0 && (
                  <FindingGroup title="Исправлены">
                    <FindingList findings={closed} projectId={projectId} closed />
                  </FindingGroup>
                )}
              </div>
            </CollapsibleCard>
          )}

          {openInClosedPr.length > 0 && (
            <CollapsibleCard title="В pull request'ах, закрытых без слияния" count={openInClosedPr.length}>
              <FindingList findings={openInClosedPr} projectId={projectId} />
            </CollapsibleCard>
          )}

          {analyses.length > 0 && (
            <CollapsibleCard title="История разборов" count={analyses.length}>
              <AnalysisList analyses={analyses} projectId={projectId} />
            </CollapsibleCard>
          )}
        </div>
      </PageShell>
    </>
  );
}

function unreviewedReason(status: string, note: string | null): string {
  if (status === "failed") return "разбор не удался";
  return note === "limit" ? "исчерпан дневной лимит, разбор в очереди" : "не успел вовремя, разбор в очереди";
}

/** Reopened first (the model re-flagged it), then by severity, then most recent. */
function compareOpen(a: FindingRow, b: FindingRow): number {
  const re = Number(b.status === "reopened") - Number(a.status === "reopened");
  if (re !== 0) return re;
  const sev = severityRank(b.severity) - severityRank(a.severity);
  if (sev !== 0) return sev;
  return b.updatedAt.localeCompare(a.updatedAt);
}

function FindingGroup({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: "amber";
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className={cn("mb-2 text-xs font-semibold", tone === "amber" ? "text-amber" : "text-muted-foreground")}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function FindingList({
  findings,
  projectId,
  closed,
}: {
  findings: FindingRow[];
  projectId: number;
  closed?: boolean;
}) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {findings.map((f) => (
        <li key={f.id} className="py-3 first:pt-0 last:pb-0">
          <Link
            href={`/projects/${projectId}/findings/${f.id}`}
            className="group flex items-start justify-between gap-3"
          >
            <div className="min-w-0">
              <p className={cn("font-medium group-hover:underline", closed && "text-foreground/80")}>
                {f.title}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {areaLabel(f.area)}
                {" · "}
                {closed
                  ? relativeDate(f.updatedAt)
                  : `с ${relativeDate(f.status === "reopened" ? (f.reopenedAt ?? f.updatedAt) : f.createdAt)}`}
              </p>
              {closed && f.lastReason && <p className="mt-1 text-xs">{f.lastReason}</p>}
            </div>
            {!closed && (
              <div className="flex shrink-0 items-center gap-1.5">
                {f.status !== "open" && (
                  <Badge tone={f.status === "reopened" ? "red" : "amber"}>
                    {findingStatusLabel(f.status)}
                  </Badge>
                )}
                <SeverityBadge severity={f.severity} />
              </div>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function AnalysisList({ analyses, projectId }: { analyses: AnalysisRow[]; projectId: number }) {
  return (
    <ul className="flex flex-col divide-y divide-border text-sm">
      {analyses.map((a) => (
        <li key={a.id} className="py-2.5 first:pt-0 last:pb-0">
          <Link
            href={`/projects/${projectId}/analyses/${a.id}`}
            className="group flex flex-wrap items-center gap-x-2 gap-y-0.5"
          >
            <span className="font-medium group-hover:underline">{relativeDate(a.createdAt)}</span>
            <span className="text-muted-foreground">
              {a.prNumber ? `PR #${a.prNumber}` : "—"} · {triggerLabel(a.trigger)}
            </span>
            {a.outcome !== "ok" && (
              <Badge tone={a.outcome === "error" ? "red" : "amber"}>{outcomeLabel(a.outcome, a.trigger)}</Badge>
            )}
          </Link>
          {a.summary && <p className="mt-0.5 text-xs text-muted-foreground">{a.summary}</p>}
        </li>
      ))}
    </ul>
  );
}
