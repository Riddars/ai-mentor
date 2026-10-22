import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/users";
import {
  WORK_KINDS,
  recentTokens,
  usageByDay,
  usageByKind,
  usageByProject,
  type KindUsage,
  type ProjectUsage,
} from "@/lib/curator/store";
import { queueSettings } from "@/lib/curator/review";
import { formatTokens, workKindLabel } from "@/lib/format";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { KIND_SWATCH, UsageBars } from "@/components/usage/UsageBars";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PERIODS = [7, 30] as const;

function first(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/** The page URL with the given period and project filter. */
function href(period: number, projectId?: number): string {
  const params = new URLSearchParams();
  if (period !== 30) params.set("period", String(period));
  if (projectId !== undefined) params.set("project", String(projectId));
  const query = params.toString();
  return query ? `/usage?${query}` : "/usage";
}

const dim = (n: number) => (n === 0 ? "text-muted-foreground" : undefined);

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  const isHead = viewer.role === "head";
  const scopeId = isHead ? undefined : viewer.userId;
  const params = await searchParams;
  const period = PERIODS.find((p) => String(p) === first(params.period)) ?? 30;

  const settings = queueSettings();
  const projects = usageByProject(period, scopeId);
  // Only a project in the viewer's scope can be picked.
  const project = projects.find((p) => String(p.id) === first(params.project));
  const days = usageByDay(period, scopeId, project?.id);
  const kinds = usageByKind(period, scopeId, project?.id);
  const tokens = kinds.reduce((sum, k) => sum + k.tokens, 0);
  const runs = kinds.reduce((sum, k) => sum + k.runs, 0);
  const failures = kinds.reduce((sum, k) => sum + k.failures, 0);
  const day = project
    ? { tokens: recentTokens(project.id), budget: settings.projectDailyTokens }
    : isHead
      ? { tokens: recentTokens(null), budget: settings.dailyTokens }
      : null;

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Расход</h1>
            {project && (
              <span className="inline-flex items-center gap-2 rounded-full border border-primary bg-accent px-3 py-1 text-sm text-accent-foreground">
                <Link href={`/projects/${project.id}`} className="font-medium hover:underline">
                  {project.name ?? project.repo}
                </Link>
                <Link href={href(period)} aria-label="Все проекты" className="hover:text-foreground">
                  ×
                </Link>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {PERIODS.map((p) => (
              <Link
                key={p}
                href={href(p, project?.id)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  p === period
                    ? "border-primary bg-accent text-accent-foreground"
                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {p} дней
              </Link>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
            <Tile label={`Токены за ${period} дней`} value={formatTokens(tokens)} />
            <Tile label="Запуски модели" value={String(runs)} />
            <Tile label="Сбои" value={String(failures)} warn={failures > 0} />
            {day && (
              <Tile
                label={
                  project ? "Токены за сутки, бюджет проекта" : "Токены за сутки, бюджет сервиса"
                }
                value={formatTokens(day.tokens)}
                note={day.budget > 0 ? `из ${formatTokens(day.budget)} токенов` : undefined}
                warn={day.budget > 0 && day.tokens >= day.budget}
              />
            )}
          </div>

          <Card className="shadow-card">
            <CardHeader>
              <CardTitle>По дням</CardTitle>
            </CardHeader>
            <CardBody>
              <UsageBars days={days} period={period} />
            </CardBody>
          </Card>

          <KindTable kinds={kinds} total={tokens} />

          {!project && projects.length > 0 && (
            <ProjectTable projects={projects} period={period} budget={settings.projectDailyTokens} />
          )}
        </div>
      </PageShell>
    </>
  );
}

function Tile({ label, value, note, warn }: { label: string; value: string; note?: string; warn?: boolean }) {
  return (
    <Card className="shadow-card">
      <CardBody className="pt-5">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={cn("mt-1 text-2xl font-semibold tabular-nums", warn && "text-amber")}>{value}</div>
        {note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
      </CardBody>
    </Card>
  );
}

function KindTable({ kinds, total }: { kinds: KindUsage[]; total: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-5 py-2.5 font-medium">Вид работы</th>
              <th className="px-3 py-2.5 text-right font-medium">Запуски</th>
              <th className="px-3 py-2.5 text-right font-medium">Сбои</th>
              <th className="px-3 py-2.5 text-right font-medium">Токены</th>
              <th className="px-3 py-2.5 text-right font-medium">Доля</th>
              <th className="px-5 py-2.5 text-right font-medium">В среднем за запуск</th>
            </tr>
          </thead>
          <tbody>
            {kinds.map((k) => (
              <tr key={k.kind} className="border-b border-border last:border-0">
                <td className="px-5 py-3">
                  <span className="inline-flex items-center gap-2">
                    <span className={`size-2.5 shrink-0 rounded-sm ${KIND_SWATCH[k.kind]}`} />
                    {workKindLabel(k.kind)}
                  </span>
                </td>
                <td className={cn("px-3 py-3 text-right tabular-nums", dim(k.runs))}>{k.runs}</td>
                <td className={cn("px-3 py-3 text-right tabular-nums", k.failures > 0 ? "text-amber" : "text-muted-foreground")}>
                  {k.failures}
                </td>
                <td className={cn("px-3 py-3 text-right tabular-nums", dim(k.tokens))}>{formatTokens(k.tokens)}</td>
                <td className={cn("px-3 py-3 text-right tabular-nums", dim(k.tokens))}>
                  {total > 0 ? `${Math.round((k.tokens / total) * 100)}%` : "—"}
                </td>
                <td className="px-5 py-3 text-right text-muted-foreground tabular-nums">
                  {k.runs > 0 ? formatTokens(Math.round(k.tokens / k.runs)) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProjectTable({ projects, period, budget }: { projects: ProjectUsage[]; period: number; budget: number }) {
  const showNotReviewed = projects.some((p) => p.notReviewed > 0);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-5 py-2.5 font-medium">Проект</th>
              <th className="px-3 py-2.5 text-right font-medium">Разборы</th>
              <th className="px-3 py-2.5 text-right font-medium">Сбои</th>
              {showNotReviewed && <th className="px-3 py-2.5 text-right font-medium">Отложено по лимиту</th>}
              {WORK_KINDS.map((k) => (
                <th key={k} className="px-3 py-2.5 text-right font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`size-2 shrink-0 rounded-sm ${KIND_SWATCH[k]}`} />
                    {workKindLabel(k)}
                  </span>
                </th>
              ))}
              <th className="px-3 py-2.5 text-right font-medium">Всего</th>
              <th className="px-5 py-2.5 text-right font-medium">За сутки</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                <td className="px-5 py-3">
                  <Link href={href(period, p.id)} className="font-medium hover:underline">
                    {p.name ?? p.repo}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {p.owner}/{p.repo}
                  </div>
                </td>
                <td className={cn("px-3 py-3 text-right tabular-nums", dim(p.reviews))}>{p.reviews}</td>
                <td className={cn("px-3 py-3 text-right tabular-nums", p.failures > 0 ? "text-amber" : "text-muted-foreground")}>
                  {p.failures}
                </td>
                {showNotReviewed && (
                  <td className={cn("px-3 py-3 text-right tabular-nums", p.notReviewed > 0 ? "text-amber" : "text-muted-foreground")}>
                    {p.notReviewed}
                  </td>
                )}
                {WORK_KINDS.map((k) => (
                  <td key={k} className={cn("px-3 py-3 text-right tabular-nums", dim(p[k]))}>
                    {formatTokens(p[k])}
                  </td>
                ))}
                <td className={cn("px-3 py-3 text-right font-medium tabular-nums", dim(p.tokens))}>{formatTokens(p.tokens)}</td>
                <td
                  className={cn(
                    "px-5 py-3 text-right text-xs whitespace-nowrap tabular-nums",
                    budget > 0 && p.dayTokens >= budget ? "text-amber" : "text-muted-foreground",
                  )}
                >
                  {formatTokens(p.dayTokens)}
                  {budget > 0 && ` / ${formatTokens(budget)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
