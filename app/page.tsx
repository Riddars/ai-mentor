import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/users";
import { listProjectSummaries, type ProjectSummary } from "@/lib/curator/store";
import { attentionFor } from "@/lib/attention";
import { relativeDate } from "@/lib/format";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Badge, StatusDot } from "@/components/ui/Badge";

export const dynamic = "force-dynamic";

const LEVEL_ORDER = { red: 0, yellow: 1, green: 2 } as const;

export default async function OverviewPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");

  const projects = listProjectSummaries(
    viewer.role === "supervisor" ? viewer.userId : undefined,
  );
  const sorted = [...projects].sort(
    (a, b) => LEVEL_ORDER[attentionFor(a).level] - LEVEL_ORDER[attentionFor(b).level],
  );
  const needAttention = sorted.filter((p) => attentionFor(p).level !== "green").length;

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <div className="mb-6 flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Проекты</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {viewer.role === "head"
                ? "Все проекты центра."
                : "Проекты под вашим руководством."}
            </p>
          </div>
          {sorted.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Требуют внимания: <span className="font-semibold text-foreground">{needAttention}</span>{" "}
              из {sorted.length}
            </p>
          )}
        </div>

        {sorted.length === 0 ? (
          <EmptyState head={viewer.role === "head"} />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Статус</th>
                  <th className="px-4 py-3 font-medium">Проект</th>
                  <th className="px-4 py-3 font-medium">Участники</th>
                  <th className="px-4 py-3 font-medium">Замечания</th>
                  <th className="px-4 py-3 font-medium">Активность</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => (
                  <ProjectRow key={p.id} project={p} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageShell>
    </>
  );
}

function ProjectRow({ project }: { project: ProjectSummary }) {
  const attention = attentionFor(project);
  return (
    <tr className="border-b border-border last:border-0 hover:bg-muted/50">
      <td className="px-4 py-3 align-top">
        <div className="flex items-start gap-2">
          <span className="mt-0.5">
            <StatusDot tone={attention.level === "yellow" ? "amber" : attention.level} />
          </span>
          <span className="max-w-52 text-xs text-muted-foreground">{attention.reason}</span>
        </div>
      </td>
      <td className="px-4 py-3 align-top">
        <Link href={`/projects/${project.id}`} className="font-medium hover:underline">
          {project.name ?? project.repo}
        </Link>
        <div className="text-xs text-muted-foreground">
          {project.owner}/{project.repo}
        </div>
        {project.status === "paused" && (
          <Badge tone="neutral" className="mt-1">
            на паузе
          </Badge>
        )}
      </td>
      <td className="px-4 py-3 align-top text-xs text-muted-foreground">
        {project.participants.length > 0 ? project.participants.join(", ") : "—"}
      </td>
      <td className="px-4 py-3 align-top">
        {project.openFindings === 0 ? (
          <span className="text-xs text-muted-foreground">нет</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            <Badge tone={project.seriousOpenFindings > 0 ? "red" : "amber"}>
              открытых: {project.openFindings}
            </Badge>
            {project.seriousOpenFindings > 0 && (
              <Badge tone="red">серьёзных: {project.seriousOpenFindings}</Badge>
            )}
          </div>
        )}
      </td>
      <td className="px-4 py-3 align-top text-xs text-muted-foreground">
        {relativeDate(project.lastActivityAt)}
      </td>
    </tr>
  );
}

function EmptyState({ head }: { head: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
      <p className="text-sm text-muted-foreground">
        Проектов пока нет.
        {head && (
          <>
            {" "}
            Добавьте репозиторий в{" "}
            <Link href="/admin" className="text-primary hover:underline">
              управлении
            </Link>
            .
          </>
        )}
      </p>
    </div>
  );
}
