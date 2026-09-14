import type { WeekPoint } from "@/lib/metrics";

// The panel's single chart: a tiny bar strip of analyses per week, GitHub-style.
// Glanceable "alive / gone quiet"; no axes, no legend. Hover text via <title>.
export function Sparkline({ points }: { points: WeekPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const total = points.reduce((s, p) => s + p.value, 0);
  const W = points.length * 6 - 2;
  const H = 16;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className="shrink-0 overflow-visible"
      role="img"
      aria-label={`Разборов за ${points.length} недель: ${total}`}
    >
      {points.map((p, i) => {
        const h = p.value === 0 ? 2 : Math.max(3, Math.round((p.value / max) * H));
        return (
          <rect
            key={i}
            x={i * 6}
            y={H - h}
            width={4}
            height={h}
            rx={1}
            className={p.value === 0 ? "fill-muted-foreground/25" : "fill-primary"}
          >
            <title>{`${p.title}: ${p.value} разборов`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
