import type { Role } from "@/lib/auth";
import type { FindingStatus } from "@/lib/curator/store";

/** SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) → Date; null when missing or malformed. */
export function parseDbDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** "сегодня" / "вчера" / "N дней назад" / "D month YYYY". */
export function relativeDate(iso: string | null): string {
  const date = parseDbDate(iso);
  if (!date) return "—";
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (dayDiff === 0) return "сегодня";
  if (dayDiff === 1) return "вчера";
  if (dayDiff < 7) return `${dayDiff} ${plural(dayDiff, "день", "дня", "дней")} назад`;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

export function fullDate(iso: string | null): string {
  const date = parseDbDate(iso);
  if (!date) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const FINDING_STATUS_LABEL: Record<FindingStatus, string> = {
  open: "Открыта",
  reopened: "Открыта повторно",
  pending: "Ожидает проверки",
  closed: "Закрыта",
  dismissed: "Снята",
};

export function findingStatusLabel(status: FindingStatus): string {
  return FINDING_STATUS_LABEL[status] ?? status;
}

export function isOpenStatus(status: FindingStatus): boolean {
  return status === "open" || status === "reopened" || status === "pending";
}

export function severityLabel(severity: string | null): string {
  switch ((severity ?? "").toLowerCase()) {
    case "critical":
      return "критическая";
    case "high":
      return "высокая";
    case "medium":
      return "средняя";
    case "low":
      return "низкая";
    default:
      return severity ?? "—";
  }
}

export type SeverityKey = "critical" | "high" | "medium" | "low" | "other";

/** Normalise a raw severity string to one of the ordinal buckets. */
export function severityKey(severity: string | null): SeverityKey {
  switch ((severity ?? "").toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return "other";
  }
}

/** Higher = more serious. Used to sort findings by severity. */
export function severityRank(severity: string | null): number {
  return { critical: 4, high: 3, medium: 2, low: 1, other: 0 }[severityKey(severity)];
}

// The model writes the category as free Russian text (see the prompt in
// review.ts), so it is shown as is — no mapping that only the seed would hit.
export function categoryLabel(category: string | null): string {
  return category?.trim() || "Без категории";
}

/**
 * Human label for an analysis outcome. A failed commit analysis leaves the
 * check-run at action_required; a failed comment reconciliation blocks nothing.
 */
export function outcomeLabel(outcome: string | null, trigger: string | null): string {
  switch (outcome) {
    case null:
      return "разборов не было";
    case "ok":
      return "ok";
    case "parse_error":
      return "ответ модели не разобран";
    case "error":
      return trigger === "comment" ? "сбой сверки по ответу студента" : "ошибка разбора";
    default:
      return outcome;
  }
}

const PR_STATE_LABEL: Record<string, string> = {
  open: "открыт",
  merged: "слит",
  closed: "закрыт без слияния",
};

export function prStateLabel(state: string | null): string {
  if (!state) return "—";
  return PR_STATE_LABEL[state] ?? state;
}

const TRIGGER_LABEL: Record<string, string> = {
  commit: "коммит",
  comment: "комментарий",
};

export function triggerLabel(trigger: string): string {
  return TRIGGER_LABEL[trigger] ?? trigger;
}

const ROLE_LABEL: Record<Role, string> = {
  head: "руководитель центра",
  supervisor: "руководитель проекта",
};

export function roleLabel(role: Role): string {
  return ROLE_LABEL[role];
}

/** Russian plural for "замечание" (1 замечание / 2 замечания / 5 замечаний). */
export function findingsWord(n: number): string {
  return plural(n, "замечание", "замечания", "замечаний");
}

/** Russian plural for "проект". */
export function projectsWord(n: number): string {
  return plural(n, "проект", "проекта", "проектов");
}
