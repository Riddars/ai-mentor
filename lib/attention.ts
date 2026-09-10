import type { ProjectSummary } from "@/lib/curator/store";

// Attention level derived from finding age and activity, paired with a
// human-readable reason. Thresholds are named constants so the rule stays in one
// place.

export type AttentionLevel = "red" | "yellow" | "green";

export interface Attention {
  level: AttentionLevel;
  reason: string;
}

const SERIOUS_OPEN_DAYS = 14;
const STALE_DAYS = 30;
const SLOWING_DAYS = 14;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(iso.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

export function attentionFor(p: ProjectSummary): Attention {
  if (p.status === "paused") {
    return { level: "green", reason: "Проект на паузе — замечания не отслеживаются." };
  }

  const idle = daysSince(p.lastActivityAt);
  const seriousAge = daysSince(p.oldestSeriousOpenAt);

  if (seriousAge !== null && seriousAge >= SERIOUS_OPEN_DAYS) {
    return {
      level: "red",
      reason: `Серьёзное замечание открыто ${seriousAge} дн. без реакции.`,
    };
  }
  if (idle !== null && idle >= STALE_DAYS) {
    return { level: "red", reason: `Нет активности ${idle} дн.` };
  }

  if (p.seriousOpenFindings > 0) {
    return {
      level: "yellow",
      reason: `Открытых серьёзных замечаний: ${p.seriousOpenFindings}.`,
    };
  }
  if (idle !== null && idle >= SLOWING_DAYS) {
    return { level: "yellow", reason: `Активности нет ${idle} дн.` };
  }
  if (p.openFindings > 0) {
    return { level: "yellow", reason: `Открытых замечаний: ${p.openFindings}.` };
  }

  return { level: "green", reason: "Открытых замечаний нет, проект активен." };
}
