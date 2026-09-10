import type { FindingStatus } from "@/lib/curator/store";

function parse(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "сегодня" / "вчера" / "N дней назад" / "D month YYYY". */
export function relativeDate(iso: string | null): string {
  const date = parse(iso);
  if (!date) return "—";
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (dayDiff === 0) return "сегодня";
  if (dayDiff === 1) return "вчера";
  if (dayDiff < 7) return `${dayDiff} дн. назад`;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

export function fullDate(iso: string | null): string {
  const date = parse(iso);
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
    case "high":
    case "critical":
      return "высокая";
    case "medium":
      return "средняя";
    case "low":
      return "низкая";
    default:
      return severity ?? "—";
  }
}

export function isSerious(severity: string | null): boolean {
  const s = (severity ?? "").toLowerCase();
  return s === "high" || s === "critical";
}
