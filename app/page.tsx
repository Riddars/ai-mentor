import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/users";
import { listProjectSummaries, type ProjectSummary } from "@/lib/curator/store";
import { parseDbDate, relativeDate } from "@/lib/format";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SortKey = "serious" | "activity" | "name";
type Dir = "asc" | "desc";
const SORT_KEYS: SortKey[] = ["serious", "activity", "name"];
const DEFAULT_DIR: Record<SortKey, Dir> = {
  serious: "desc",
  activity: "asc",
  name: "asc",
};

interface Query {
  sort: SortKey;
  dir: Dir;
  supervisor: string; // login, "none", or ""
  paused: boolean;
}

function parseQuery(raw: Record<string, string | string[] | undefined>, isHead: boolean): Query {
  const one = (k: string) => (Array.isArray(raw[k]) ? raw[k]?.[0] : raw[k]) ?? "";
  const sort = SORT_KEYS.includes(one("sort") as SortKey) ? (one("sort") as SortKey) : "serious";
  const dir = one("dir") === "asc" || one("dir") === "desc" ? (one("dir") as Dir) : DEFAULT_DIR[sort];
  return {
    sort,
    dir,
    // A supervisor's scope is fixed to their own projects; the filter is head-only.
    supervisor: isHead ? one("supervisor") : "",
    paused: one("paused") === "1",
  };
}

function href(q: Query, patch: Partial<Query>): string {
  const next = { ...q, ...patch };
  const params = new URLSearchParams();
  if (next.sort !== "serious" || next.dir !== DEFAULT_DIR[next.sort]) {
    params.set("sort", next.sort);
    params.set("dir", next.dir);
  }
  if (next.supervisor) params.set("supervisor", next.supervisor);
  if (next.paused) params.set("paused", "1");
  const s = params.toString();
  return s ? `/?${s}` : "/";
}

function ts(iso: string | null): number {
  return parseDbDate(iso)?.getTime() ?? 0;
}

function compare(a: ProjectSummary, b: ProjectSummary, q: Query): number {
  const sign = q.dir === "asc" ? 1 : -1;
  const byName = () => (a.name ?? a.repo).localeCompare(b.name ?? b.repo, "ru");
  switch (q.sort) {
    case "serious": {
      // Critical count, then all open, then the oldest critical first, then the
      // least recently active.
      const d = a.seriousOpenFindings - b.seriousOpenFindings;
      if (d !== 0) return sign * d;
      const open = a.openFindings - b.openFindings;
      if (open !== 0) return sign * open;
      const age = ts(a.oldestSeriousOpenAt) - ts(b.oldestSeriousOpenAt);
      if (age !== 0) return q.dir === "desc" ? age : -age;
      const last = ts(a.lastActivityAt) - ts(b.lastActivityAt);
      return last !== 0 ? (q.dir === "desc" ? last : -last) : byName();
    }
    case "activity": {
      const d = ts(a.lastActivityAt) - ts(b.lastActivityAt);
      return d !== 0 ? sign * d : byName();
    }
    case "name":
      return sign * byName();
  }
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  const isHead = viewer.role === "head";
  const scopeId = isHead ? undefined : viewer.userId;
  const q = parseQuery(await searchParams, isHead);

  const all = listProjectSummaries(scopeId);
  const supervisorLogins = [...new Set(all.flatMap((p) => p.supervisors))].sort();

  const filtered = all.filter((p) => {
    if (!q.paused && p.status === "paused") return false;
    if (q.supervisor === "none") return p.supervisors.length === 0;
    if (q.supervisor) return p.supervisors.includes(q.supervisor);
    return true;
  });
  const rows = [...filtered].sort((a, b) => compare(a, b, q));
  const pausedTotal = all.filter((p) => p.status === "paused").length;

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Проекты</h1>
          <Filters q={q} isHead={isHead} supervisorLogins={supervisorLogins} pausedTotal={pausedTotal} />
        </div>

        {all.length === 0 ? (
          <EmptyState head={isHead} />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                    <SortHeader q={q} k="name" className="px-5">Проект</SortHeader>
                    {isHead && <th className="px-3 py-2.5 font-medium">Руководитель</th>}
                    <th className="px-3 py-2.5 font-medium">Участники</th>
                    <SortHeader q={q} k="serious">Замечания</SortHeader>
                    <SortHeader q={q} k="activity" className="px-5">Последняя активность</SortHeader>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={isHead ? 5 : 4} className="px-5 py-10 text-center text-sm text-muted-foreground">
                        Под текущие фильтры проектов нет.
                      </td>
                    </tr>
                  ) : (
                    rows.map((p) => <ProjectRow key={p.id} p={p} isHead={isHead} />)
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </PageShell>
    </>
  );
}

function Filters({
  q,
  isHead,
  supervisorLogins,
  pausedTotal,
}: {
  q: Query;
  isHead: boolean;
  supervisorLogins: string[];
  pausedTotal: number;
}) {
  const chip = (active: boolean) =>
    cn(
      "rounded-full border px-2.5 py-1 text-xs transition-colors",
      active
        ? "border-primary bg-accent text-accent-foreground"
        : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
    );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {isHead && supervisorLogins.length > 0 && (
        <>
          <Link href={href(q, { supervisor: "" })} className={chip(q.supervisor === "")}>
            все
          </Link>
          {supervisorLogins.map((login) => (
            <Link key={login} href={href(q, { supervisor: login })} className={chip(q.supervisor === login)}>
              {login}
            </Link>
          ))}
          <Link href={href(q, { supervisor: "none" })} className={chip(q.supervisor === "none")}>
            без руководителя
          </Link>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        </>
      )}
      {pausedTotal > 0 && (
        <Link href={href(q, { paused: !q.paused })} className={chip(q.paused)}>
          {q.paused ? "скрыть на паузе" : "показать на паузе"}
        </Link>
      )}
    </div>
  );
}

function SortHeader({
  q,
  k,
  className,
  children,
}: {
  q: Query;
  k: SortKey;
  className?: string;
  children: React.ReactNode;
}) {
  const active = q.sort === k;
  const nextDir: Dir = active ? (q.dir === "asc" ? "desc" : "asc") : DEFAULT_DIR[k];
  return (
    <th className={cn("py-2.5 font-medium", className ?? "px-3")}>
      <Link
        href={href(q, { sort: k, dir: nextDir })}
        className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")}
      >
        {children}
        {active && (
          <span aria-hidden className="text-[0.6rem]">
            {q.dir === "asc" ? "▲" : "▼"}
          </span>
        )}
      </Link>
    </th>
  );
}

function ProjectRow({ p, isHead }: { p: ProjectSummary; isHead: boolean }) {
  const failed = p.lastAnalysisOutcome === "error" || p.lastAnalysisOutcome === "parse_error";
  return (
    <tr className="border-b border-border last:border-0 hover:bg-muted/40">
      <td className="px-5 py-3 align-top">
        <Link href={`/projects/${p.id}`} className="font-medium hover:underline">
          {p.name ?? p.repo}
        </Link>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <a
            href={`https://github.com/${p.owner}/${p.repo}`}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            {p.owner}/{p.repo}
          </a>
          {p.status === "paused" && <Badge tone="neutral">пауза</Badge>}
          {p.blockedPrs > 0 ? (
            <Badge tone="red">слияние заблокировано</Badge>
          ) : (
            failed && <Badge tone="amber">сбой разбора</Badge>
          )}
        </div>
      </td>
      {isHead && (
        <td className="px-3 py-3 align-top text-xs">
          {p.supervisors.length > 0 ? (
            p.supervisors.join(", ")
          ) : (
            <span className="text-amber">не назначен</span>
          )}
        </td>
      )}
      <td className="px-3 py-3 align-top text-xs text-muted-foreground">
        {p.participants.length > 0 ? p.participants.join(", ") : "—"}
      </td>
      <td className="px-3 py-3 align-top">
        {p.openFindings === 0 ? (
          <span className="text-xs text-muted-foreground">нет</span>
        ) : (
          <span className={cn("font-medium tabular-nums", p.seriousOpenFindings > 0 && "text-red")}>
            {p.openFindings}
          </span>
        )}
      </td>
      <td className="px-5 py-3 align-top text-xs whitespace-nowrap text-muted-foreground">
        {relativeDate(p.lastActivityAt)}
      </td>
    </tr>
  );
}

function EmptyState({ head }: { head: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center shadow-card">
      <p className="text-sm text-muted-foreground">
        {head ? (
          <>
            Проектов пока нет. Добавьте репозиторий в{" "}
            <Link href="/admin" className="text-primary hover:underline">
              управлении
            </Link>
            .
          </>
        ) : (
          "Вам не назначены проекты — обратитесь к руководителю центра."
        )}
      </p>
    </div>
  );
}
