import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/users";
import { getAnalysis, getProject, isSupervisorOf, listAnalysisChanges } from "@/lib/curator/store";
import { findingStatusLabel, fullDate, outcomeLabel, triggerLabel } from "@/lib/format";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { CollapsibleCard } from "@/components/ui/Collapsible";

export const dynamic = "force-dynamic";

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ id: string; aid: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");

  const { id, aid } = await params;
  const projectId = Number(id);
  const analysis = getAnalysis(Number(aid));
  if (!analysis || analysis.projectId !== projectId) notFound();
  if (viewer.role === "supervisor" && !isSupervisorOf(viewer.userId, projectId)) {
    notFound();
  }

  const project = getProject(projectId);
  if (!project) notFound();
  const repoUrl = `https://github.com/${project.owner}/${project.repo}`;
  const changes = listAnalysisChanges(analysis.id);
  const materials = analysis.materials;
  const omitted = materials?.omitted ?? [];
  const sent = (materials?.files ?? []).filter((f) => !omitted.includes(f));
  const model = [analysis.provider, analysis.model].filter(Boolean).join(" / ");

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <Breadcrumbs
          items={[
            { label: "Проекты", href: "/" },
            { label: project.name ?? project.repo, href: `/projects/${projectId}` },
            { label: "Разбор" },
          ]}
        />

        <div className="mt-2 mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Разбор {fullDate(analysis.createdAt)}</h1>
            {analysis.outcome !== "ok" && (
              <Badge tone={analysis.outcome === "error" ? "red" : "amber"}>
                {outcomeLabel(analysis.outcome, analysis.trigger)}
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {analysis.prNumber && (
              <a href={`${repoUrl}/pull/${analysis.prNumber}`} target="_blank" rel="noreferrer" className="hover:underline">
                PR #{analysis.prNumber}
              </a>
            )}
            <span>{triggerLabel(analysis.trigger)}</span>
            <a
              href={`${repoUrl}/commit/${analysis.headSha}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs hover:underline"
            >
              {analysis.headSha.slice(0, 7)}
            </a>
            {model && <span>{model}</span>}
          </div>
          {analysis.summary && <p className="mt-3 text-sm">{analysis.summary}</p>}
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <div className="flex flex-col gap-5 lg:col-span-2">
            {analysis.comment && (
              <Card className="shadow-card">
                <CardHeader>
                  <CardTitle>Комментарий в pull request</CardTitle>
                </CardHeader>
                <CardBody className="pt-0">
                  <Markdown>{analysis.comment}</Markdown>
                </CardBody>
              </Card>
            )}
            {analysis.rawResponse && (
              <CollapsibleCard title="Ответ модели как есть">
                <pre className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs whitespace-pre-wrap">
                  <code>{analysis.rawResponse}</code>
                </pre>
              </CollapsibleCard>
            )}
            {changes.length > 0 && (
              <Card className="shadow-card">
                <CardHeader>
                  <CardTitle>Изменения по замечаниям</CardTitle>
                </CardHeader>
                <CardBody className="pt-0">
                  <ul className="flex flex-col divide-y divide-border text-sm">
                    {changes.map((c, i) => (
                      <li key={i} className="py-2.5 first:pt-0 last:pb-0">
                        <div className="flex items-start justify-between gap-3">
                          <Link
                            href={`/projects/${projectId}/findings/${c.findingId}`}
                            className="font-medium hover:underline"
                          >
                            {c.title}
                          </Link>
                          <Badge tone={c.oldStatus === null ? "primary" : "neutral"}>
                            {c.oldStatus === null ? "новое" : findingStatusLabel(c.newStatus)}
                          </Badge>
                        </div>
                        {c.prNumber !== analysis.prNumber && (
                          <p className="mt-0.5 text-xs text-muted-foreground">найдено в PR #{c.prNumber}</p>
                        )}
                        {c.reason && <p className="mt-0.5 text-xs text-muted-foreground">{c.reason}</p>}
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            )}
          </div>

          {materials && (
            <Card className="h-fit shadow-card">
              <CardHeader>
                <CardTitle>Что получила модель</CardTitle>
              </CardHeader>
              <CardBody className="flex flex-col gap-3 pt-0 text-sm">
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">Изменённые файлы</p>
                  {sent.length > 0 ? (
                    <ul className="flex flex-col gap-0.5">
                      {sent.map((f) => (
                        <li key={f} className="font-mono text-xs break-all">
                          {f}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground">—</p>
                  )}
                </div>
                {(omitted.length > 0 || (materials.unlisted ?? 0) > 0 || (materials.truncated && !materials.omitted)) && (
                  <div>
                    <p className="mb-1 text-xs text-amber">Не переданы модели из-за объёма</p>
                    {omitted.length > 0 && (
                      <ul className="flex flex-col gap-0.5">
                        {omitted.map((f) => (
                          <li key={f} className="font-mono text-xs break-all">
                            {f}
                          </li>
                        ))}
                      </ul>
                    )}
                    {(materials.unlisted ?? 0) > 0 && (
                      <p className="text-xs">ещё {materials.unlisted} файлов сверх лимита списка</p>
                    )}
                    {materials.truncated && !materials.omitted && (
                      <p className="text-xs">часть изменений обрезана</p>
                    )}
                  </div>
                )}
                <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">RESEARCH.md</dt>
                  <dd>{materials.researchDoc ? "есть" : "нет"}</dd>
                  {materials.planDoc !== undefined && (
                    <>
                      <dt className="text-muted-foreground">PLAN.md</dt>
                      <dd>{materials.planDoc ? "есть" : "нет"}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Открытые замечания проекта</dt>
                  <dd className="tabular-nums">{materials.priorFindings}</dd>
                  <dt className="text-muted-foreground">Ответы студента</dt>
                  <dd className="tabular-nums">{materials.studentResponses}</dd>
                </dl>
              </CardBody>
            </Card>
          )}
        </div>
      </PageShell>
    </>
  );
}
