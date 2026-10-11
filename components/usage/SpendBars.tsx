import type { DaySpend } from "@/lib/curator/store";
import { formatRub, formatTokens } from "@/lib/format";

const DAY = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Rubles per day as bars, one per day of the period ending today; hover shows the day. */
export function SpendBars({ days, period }: { days: DaySpend[]; period: number }) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const series = Array.from({ length: period }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - (period - 1 - i));
    const key = localDay(date);
    return { date, spend: byDay.get(key) ?? { day: key, rub: 0, tokens: 0, analyses: 0, unpriced: 0 } };
  });
  const max = Math.max(...series.map((s) => s.spend.rub), 0);
  const label = (i: number) => DAY.format(series[i].date);

  return (
    <div>
      <svg
        viewBox={`0 0 ${period * 10} 100`}
        preserveAspectRatio="none"
        className="h-36 w-full"
        role="img"
        aria-label={`Расход по дням за ${period} дней`}
      >
        {series.map(({ date, spend }, i) => {
          const h = max > 0 ? Math.max((spend.rub / max) * 100, spend.rub > 0 ? 1.5 : 0) : 0;
          return (
            <g key={spend.day}>
              <title>
                {`${DAY.format(date)} · ${formatRub(spend.rub)} · ${formatTokens(spend.tokens)} токенов · разборов: ${spend.analyses}`}
              </title>
              <rect x={i * 10} y={0} width={10} height={100} fill="transparent" />
              <rect x={i * 10 + 1.5} y={100 - h} width={7} height={h} rx={1} className="fill-primary" />
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
  );
}
