import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/users";
import {
  listBalanceEntries,
  providerBalances,
  recentTokens,
  spendByDay,
  spendByProject,
  type ProjectSpend,
} from "@/lib/curator/store";
import { queueSettings } from "@/lib/curator/review";
import { deleteBalanceEntryAction } from "@/app/actions/usage";
import { KNOWN_PROVIDERS, formatRub, formatTokens, fullDate, providerLabel } from "@/lib/format";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { CollapsibleCard } from "@/components/ui/Collapsible";
import { BalanceEntryForm } from "@/components/usage/BalanceEntryForm";
import { SpendBars } from "@/components/usage/SpendBars";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PERIODS = [7, 30] as const;

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  const isHead = viewer.role === "head";
  const scopeId = isHead ? undefined : viewer.userId;
  const raw = (await searchParams).period;
  const period = PERIODS.find((p) => String(p) === (Array.isArray(raw) ? raw[0] : raw)) ?? 30;

  const settings = queueSettings();
  const days = spendByDay(period, scopeId);
  const projects = spendByProject(period, scopeId);
  const total = days.reduce((sum, d) => sum + d.rub, 0);
  const unpriced = days.some((d) => d.unpriced > 0);
  const showNotReviewed = projects.some((p) => p.notReviewed > 0);

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Расход</h1>
          <div className="flex items-center gap-1.5">
            {PERIODS.map((p) => (
              <Link
                key={p}
                href={p === 30 ? "/usage" : `/usage?period=${p}`}
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
          {isHead && <Balance dailyTokens={settings.dailyTokens} />}

          <Card className="shadow-card">
            <CardHeader className="flex items-center justify-between gap-3">
              <CardTitle>По дням</CardTitle>
              <div className="flex items-center gap-2">
                {unpriced && <Badge tone="amber">есть модель без цены</Badge>}
                <span className="text-sm font-medium tabular-nums">{formatRub(total)}</span>
              </div>
            </CardHeader>
            <CardBody>
              <SpendBars days={days} period={period} />
            </CardBody>
          </Card>

          {projects.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                      <th className="px-5 py-2.5 font-medium">Проект</th>
                      <th className="px-3 py-2.5 text-right font-medium">Разборы</th>
                      <th className="px-3 py-2.5 text-right font-medium">Сбои</th>
                      {showNotReviewed && <th className="px-3 py-2.5 text-right font-medium">Отложено по лимиту</th>}
                      <th className="px-3 py-2.5 text-right font-medium">Токены</th>
                      <th className="px-3 py-2.5 text-right font-medium">Расход</th>
                      <th className="px-5 py-2.5 text-right font-medium">За сутки</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p) => (
                      <ProjectRow
                        key={p.id}
                        p={p}
                        showNotReviewed={showNotReviewed}
                        budget={settings.projectDailyTokens}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </PageShell>
    </>
  );
}

function ProjectRow({ p, showNotReviewed, budget }: { p: ProjectSpend; showNotReviewed: boolean; budget: number }) {
  const dim = (n: number) => (n === 0 ? "text-muted-foreground" : undefined);
  return (
    <tr className="border-b border-border last:border-0 hover:bg-muted/40">
      <td className="px-5 py-3">
        <Link href={`/projects/${p.id}`} className="font-medium hover:underline">
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
      <td className={cn("px-3 py-3 text-right tabular-nums", dim(p.tokens))}>{formatTokens(p.tokens)}</td>
      <td className={cn("px-3 py-3 text-right whitespace-nowrap tabular-nums", dim(p.rub))}>
        {formatRub(p.rub)}
        {p.unpriced > 0 && (
          <span className="ml-1 text-amber" title={`без цены: ${formatTokens(p.unpriced)} токенов`}>
            +?
          </span>
        )}
      </td>
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
  );
}

function Balance({ dailyTokens }: { dailyTokens: number }) {
  const balances = providerBalances();
  const entries = listBalanceEntries();
  const dayTokens = recentTokens(null);
  const configured = [process.env.LLM_PROVIDER, process.env.LLM_FALLBACK_PROVIDER].filter(
    (p): p is string => Boolean(p),
  );
  const known = [...configured, ...entries.map((e) => e.provider)];
  const providers = [...new Set(known.length > 0 ? known : KNOWN_PROVIDERS)].map((id) => ({
    id,
    label: providerLabel(id),
  }));

  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {balances.map((b) => (
          <Card key={b.provider} className="shadow-card">
            <CardBody className="pt-5">
              <div className="text-xs text-muted-foreground">{providerLabel(b.provider)}</div>
              <div className={cn("mt-1 text-2xl font-semibold tabular-nums", b.rub <= 0 && "text-red")}>
                ≈ {formatRub(b.rub)}
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                {b.dailyRub > 0 && b.rub > 0 && <span>≈ {Math.floor(b.rub / b.dailyRub)} дн.</span>}
                {b.unpriced > 0 && <Badge tone="amber">есть модель без цены</Badge>}
              </div>
            </CardBody>
          </Card>
        ))}
        <Card className="shadow-card">
          <CardBody className="pt-5">
            <div className="text-xs text-muted-foreground">Токены за сутки</div>
            <div
              className={cn(
                "mt-1 text-2xl font-semibold tabular-nums",
                dailyTokens > 0 && dayTokens >= dailyTokens && "text-amber",
              )}
            >
              {formatTokens(dayTokens)}
            </div>
            {dailyTokens > 0 && (
              <div className="mt-1 text-xs text-muted-foreground">из {formatTokens(dailyTokens)}</div>
            )}
          </CardBody>
        </Card>
      </div>

      <CollapsibleCard title="Пополнения" count={entries.length}>
        <div className="flex flex-col gap-4">
          <BalanceEntryForm providers={providers} />
          {entries.length > 0 && (
            <ul className="flex flex-col divide-y divide-border text-sm">
              {entries.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <span className="font-medium tabular-nums">{formatRub(e.amountRub)}</span>
                    <span className="text-muted-foreground">
                      {" · "}
                      {e.kind === "topup" ? "пополнение" : "остаток в кабинете"}
                      {" · "}
                      {providerLabel(e.provider)}
                    </span>
                    <div className="text-xs text-muted-foreground">
                      {fullDate(e.at)}
                      {e.actor && ` · ${e.actor}`}
                    </div>
                  </div>
                  <form action={deleteBalanceEntryAction}>
                    <input type="hidden" name="id" value={e.id} />
                    <button type="submit" className="text-xs text-muted-foreground hover:text-red">
                      Удалить
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CollapsibleCard>
    </>
  );
}
