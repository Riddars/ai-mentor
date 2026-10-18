import { WORK_KINDS, type DayUsage, type WorkKind } from "@/lib/curator/store";
import { formatTokens, workKindLabel } from "@/lib/format";

const DAY = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

/** Fill of each kind of work, in the fixed series order. */
export const KIND_FILL: Record<WorkKind, string> = {
  commit: "fill-series-1",
  comment: "fill-series-2",
  overview: "fill-series-3",
};

export const KIND_SWATCH: Record<WorkKind, string> = {
  commit: "bg-series-1",
  comment: "bg-series-2",
  overview: "bg-series-3",
};

/** Gap between stacked segments, in chart units (the chart is 100 high). */
const GAP = 1;

function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const total = (d: DayUsage) => WORK_KINDS.reduce((sum, k) => sum + d[k], 0);

export function KindLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {WORK_KINDS.map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className={`size-2.5 rounded-sm ${KIND_SWATCH[k]}`} />
          {workKindLabel(k)}
        </span>
      ))}
    </div>
  );
}

/** Tokens per day as bars stacked by kind of work, one per day of the period ending today. */
export function UsageBars({ days, period }: { days: DayUsage[]; period: number }) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const series = Array.from({ length: period }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - (period - 1 - i));
    const key = localDay(date);
    return { date, usage: byDay.get(key) ?? { day: key, runs: 0, commit: 0, comment: 0, overview: 0 } };
  });
  const max = Math.max(...series.map((s) => total(s.usage)), 0);
  const label = (i: number) => DAY.format(series[i].date);

  return (
    <div className="flex flex-col gap-3">
      <KindLegend />
      <div>
        <div className="mb-1 text-[0.7rem] text-muted-foreground tabular-nums">
          {max > 0 ? `${formatTokens(max)} за день` : "Нет запусков за период"}
        </div>
        <svg
          viewBox={`0 0 ${period * 10} 100`}
          preserveAspectRatio="none"
          className="h-40 w-full"
          role="img"
          aria-label={`Токены по дням за ${period} дней`}
        >
          {max > 0 && <line x1={0} x2={period * 10} y1={0.25} y2={0.25} strokeWidth={0.5} className="stroke-border" />}
          {series.map(({ date, usage }, i) => {
            let top = 100;
            const parts = WORK_KINDS.filter((k) => usage[k] > 0).map((k) => {
              // Room is left for the gaps so the tallest stack still fits.
              const h = Math.max((usage[k] / max) * (100 - GAP * (WORK_KINDS.length - 1)), 1.5);
              const y = top - h;
              top = y - GAP;
              return <rect key={k} x={i * 10 + 1.5} y={y} width={7} height={h} className={KIND_FILL[k]} />;
            });
            const lines = WORK_KINDS.filter((k) => usage[k] > 0).map((k) => `${workKindLabel(k)}: ${formatTokens(usage[k])}`);
            return (
              <g key={usage.day}>
                <title>
                  {[`${DAY.format(date)} · ${formatTokens(total(usage))} токенов · запусков: ${usage.runs}`, ...lines].join("\n")}
                </title>
                <rect x={i * 10} y={0} width={10} height={100} fill="transparent" />
                {parts}
              </g>
            );
          })}
          <line x1={0} x2={period * 10} y1={99.75} y2={99.75} strokeWidth={0.5} className="stroke-border" />
        </svg>
        <div className="mt-1.5 flex justify-between text-[0.7rem] text-muted-foreground tabular-nums">
          <span>{label(0)}</span>
          <span>{label(Math.floor((period - 1) / 2))}</span>
          <span>{label(period - 1)}</span>
        </div>
      </div>
    </div>
  );
}
