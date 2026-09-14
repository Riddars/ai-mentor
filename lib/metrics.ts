import { parseDbDate } from "@/lib/format";

// Pure presentation helper: turn analysis timestamps into the weekly series the
// sparkline consumes. No database access here.

export interface WeekPoint {
  /** Hover text, e.g. "неделя с 5 мая". */
  title: string;
  value: number;
}

/**
 * Bucket timestamps into the last `weeks` seven-day windows, oldest first. Every
 * window is present even when empty, so the strip keeps a continuous axis. The
 * last window covers the seven days ending now.
 */
export function weeklySeries(timestamps: string[], weeks: number): WeekPoint[] {
  const now = Date.now();
  const week = 7 * 86_400_000;
  const counts = new Array<number>(weeks).fill(0);

  for (const ts of timestamps) {
    const t = parseDbDate(ts)?.getTime();
    if (t === undefined) continue;
    const weeksAgo = Math.floor((now - t) / week);
    if (weeksAgo < 0 || weeksAgo >= weeks) continue;
    counts[weeks - 1 - weeksAgo] += 1;
  }

  const fmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
  return counts.map((value, i) => {
    const start = new Date(now - (weeks - i) * week);
    return { title: `неделя с ${fmt.format(start).replace(".", "")}`, value };
  });
}
