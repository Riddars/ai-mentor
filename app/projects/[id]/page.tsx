import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer, listUsers } from "@/lib/users";
import {
  countProjectAnalyses,
  getProject,
  getProjectParticipants,
  isSupervisorOf,
  listProjectAnalyses,
  listProjectFindings,
  listProjectPullRequests,
  listProjectSupervisors,
  recentAnalysisTimestampsByProject,
  type FindingRow,
  type PullRequestRow,
} from "@/lib/curator/store";
import {
  categoryLabel,
  findingStatusLabel,
  isOpenStatus,
  outcomeLabel,
  prStateLabel,
  relativeDate,
  severityRank,
  triggerLabel,
} from "@/lib/format";
import { weeklySeries } from "@/lib/metrics";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Badge, Dot, SeverityBadge, severityTone } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Sparkline } from "@/components/ui/Sparkline";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const WEEKS = 12;

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
  const pullRequests = listProjectPullRequests(projectId);
  const analyses = listProjectAnalyses(projectId);
  const analysesTotal = countProjectAnalyses(projectId);
  const points = weeklySeries(
    recentAnalysisTimestampsByProject(WEEKS, isHead ? undefined : viewer.userId)
      .filter((r) => r.projectId === projectId)
      .map((r) => r.ts),
    WEEKS,
  );
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

  const repoUrl = `https://github.com/${project.owner}/${project.repo}`;

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <Link href="/" className="text-xs text-muted-foreground hover:text-foreground">
          ← К проектам
        </Link>
        <div className="mt-2 mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">
                {project.name ?? project.repo}
              </h1>
              {project.status === "paused" && <Badge tone="neutral">на паузе — разбор отключён</Badge>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <a href={repoUrl} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">
                {project.owner}/{project.repo} ↗
              </a>
              <span>
                Участники: {participants.length > 0 ? participants.join(", ") : "пока нет"}
              </span>
              {isHead && (
                <span>
                  Руководитель:{" "}
                  {supervisors.length > 0 ? supervisors.join(", ") : <span className="text-amber">не назначен</span>}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
            <Sparkline points={points} />
            <span>разборы по неделям</span>
          </div>
        </div>

        <div className="flex flex-col gap-5">
          <FindingsCard
            title="Открытые замечания"
            findings={open}
            projectId={projectId}
            empty="Открытых замечаний нет."
          />
          {openInClosedPr.length > 0 && (
            <FindingsCard
              title="В pull requests, закрытых без слияния"
              hint="Код не попал в основную ветку; в счётчиках проекта не учитываются."
              findings={openInClosedPr}
              projectId={projectId}
              empty=""
              muted
            />
          )}

          <PullRequestsCard pullRequests={pullRequests} repoUrl={repoUrl} />

          <FindingsCard
            title="Снято по объяснению студента"
            hint="Модель приняла объяснение и сняла замечание — стоит проверить."
            findings={dismissed}
            projectId={projectId}
            empty="Снятых замечаний нет."
            muted
          />
          <FindingsCard
            title="Закрыто — исправлено"
            findings={closed}
            projectId={projectId}
            empty="Пока ничего не исправлено."
            muted
          />

          <Card className="shadow-card">
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Разборы</CardTitle>
              <span className="text-xs text-muted-foreground">
                {analyses.length < analysesTotal
                  ? `последние ${analyses.length} из ${analysesTotal}`
                  : analysesTotal}
              </span>
            </CardHeader>
            <CardBody className="pt-0">
              {analyses.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">Разборов пока не было.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border text-sm">
                  {analyses.map((a) => (
                    <li key={a.id} className="flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span>{relativeDate(a.createdAt)}</span>
                        <span>·</span>
                        <span>{a.prNumber ? `PR #${a.prNumber}` : "—"}</span>
                        <span>·</span>
                        <span>{triggerLabel(a.trigger)}</span>
                        <span>·</span>
                        <span className={cn(a.outcome === "error" && "font-medium text-red", a.outcome === "parse_error" && "text-amber")}>
                          {outcomeLabel(a.outcome, a.trigger)}
                        </span>
                      </div>
                      {a.summary && <span>{a.summary}</span>}
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

/** Reopened first (the model re-flagged it), then by severity, then most recent. */
function compareOpen(a: FindingRow, b: FindingRow): number {
  const re = Number(b.status === "reopened") - Number(a.status === "reopened");
  if (re !== 0) return re;
  const sev = severityRank(b.severity) - severityRank(a.severity);
  if (sev !== 0) return sev;
  return b.updatedAt.localeCompare(a.updatedAt);
}

function FindingsCard({
  title,
  hint,
  findings,
  projectId,
  empty,
  muted,
}: {
  title: string;
  hint?: string;
  findings: FindingRow[];
  projectId: number;
  empty: string;
  muted?: boolean;
}) {
  return (
    <Card className="shadow-card">
      <CardHeader className="flex items-start justify-between gap-3">
        <div>
          <CardTitle>{title}</CardTitle>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        <span className="text-xs text-muted-foreground">{findings.length}</span>
      </CardHeader>
      <CardBody className="pt-0">
        {findings.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {findings.map((f) => (
              <li key={f.id} className="py-3 first:pt-0 last:pb-0">
                <Link
                  href={`/projects/${projectId}/findings/${f.id}`}
                  className="group flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {!muted && <Dot tone={severityTone(f.severity)} />}
                      <p className={cn("font-medium group-hover:underline", muted && "text-foreground/80")}>
                        {f.title}
                      </p>
                    </div>
                    <p className={cn("mt-0.5 text-xs text-muted-foreground", !muted && "pl-4")}>
                      {categoryLabel(f.category)}
                      {f.file ? ` · ${f.file}${f.lines ? `:${f.lines}` : ""}` : ""}
                      {f.prNumber ? ` · PR #${f.prNumber}` : ""}
                      {f.prState === "closed" ? ` (${prStateLabel(f.prState)})` : ""}
                      {" · "}
                      {f.status === "reopened"
                        ? `повторно с ${relativeDate(f.reopenedAt ?? f.updatedAt)}`
                        : isOpenStatus(f.status)
                          ? `открыто с ${relativeDate(f.createdAt)}`
                          : relativeDate(f.updatedAt)}
                    </p>
                    {muted && f.lastReason && <p className="mt-1 text-xs">{f.lastReason}</p>}
                  </div>
                  <div className="shrink-0">
                    <FindingStatusBadge f={f} />
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
  switch (f.status) {
    case "reopened":
      return <Badge tone="red">{findingStatusLabel(f.status)}</Badge>;
    case "pending":
      return <Badge tone="amber">{findingStatusLabel(f.status)}</Badge>;
    case "closed":
      return <Badge tone="green">{findingStatusLabel(f.status)}</Badge>;
    case "dismissed":
      return <Badge tone="neutral">{findingStatusLabel(f.status)}</Badge>;
    default:
      return <SeverityBadge severity={f.severity} />;
  }
}

function PullRequestsCard({ pullRequests, repoUrl }: { pullRequests: PullRequestRow[]; repoUrl: string }) {
  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Pull requests</CardTitle>
        <span className="text-xs text-muted-foreground">{pullRequests.length}</span>
      </CardHeader>
      {pullRequests.length === 0 ? (
        <CardBody className="pt-0">
          <p className="py-3 text-sm text-muted-foreground">Pull requests ещё не было.</p>
        </CardBody>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-y border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-5 py-2 font-medium">PR</th>
                <th className="px-3 py-2 font-medium">Автор</th>
                <th className="px-3 py-2 font-medium">Состояние</th>
                <th className="px-3 py-2 font-medium">Последний разбор</th>
                <th className="px-3 py-2 font-medium">Замечания</th>
                <th className="px-5 py-2 font-medium">Ответы</th>
              </tr>
            </thead>
            <tbody>
              {pullRequests.map((pr) => (
                <tr key={pr.id} className="border-b border-border last:border-0">
                  <td className="px-5 py-2.5 align-top">
                    <a
                      href={`${repoUrl}/pull/${pr.number}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium hover:underline"
                    >
                      #{pr.number}
                    </a>
                    <div className="text-xs text-muted-foreground">{pr.title ?? "—"}</div>
                  </td>
                  <td className="px-3 py-2.5 align-top text-xs text-muted-foreground">{pr.author ?? "—"}</td>
                  <td className="px-3 py-2.5 align-top">
                    <Badge tone={pr.state === "merged" ? "green" : pr.state === "closed" ? "neutral" : "primary"}>
                      {prStateLabel(pr.state)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 align-top text-xs">
                    <div className="text-muted-foreground">{relativeDate(pr.lastAnalysisAt)}</div>
                    <div
                      className={cn(
                        pr.lastAnalysisOutcome === "error" && "font-medium text-red",
                        pr.lastAnalysisOutcome === "parse_error" && "text-amber",
                        !pr.lastAnalysisOutcome && "text-muted-foreground",
                      )}
                    >
                      {outcomeLabel(pr.lastAnalysisOutcome, pr.lastAnalysisTrigger)}
                    </div>
                    {pr.blocked && (
                      <div className="font-medium text-red">слияние заблокировано</div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 align-top text-sm tabular-nums">
                    {pr.totalFindings === 0 ? (
                      <span className="text-xs text-muted-foreground">нет</span>
                    ) : (
                      <>
                        <span className={cn("font-medium", pr.openFindings > 0 && "text-foreground")}>{pr.openFindings}</span>
                        <span className="text-muted-foreground"> / {pr.totalFindings}</span>
                      </>
                    )}
                  </td>
                  <td className="px-5 py-2.5 align-top text-sm tabular-nums text-muted-foreground">
                    {pr.responses > 0 ? pr.responses : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
