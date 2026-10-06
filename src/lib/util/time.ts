import { dayMonth, dayMonthYear, dateTimeLong, hhmm, weekdayShort } from "./fmt";

const DAY = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Compact list timestamp: 14:32 · Tue · 3 Oct · 3 Oct 2024 */
export function shortTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = startOfDay(now);
  const t = d.getTime();
  if (t >= today) return hhmm(d);
  if (t >= today - DAY) return hhmm(d);
  if (t >= today - 6 * DAY) return weekdayShort(d);
  if (d.getFullYear() === now.getFullYear()) return dayMonth(d);
  return dayMonthYear(d);
}

/** Full reader timestamp. */
export function longTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return dateTimeLong(d);
}

export function relative(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const diff = Math.max(0, now - new Date(iso).getTime());
  const s = Math.round(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export type DateGroup = "Today" | "Yesterday" | "This week" | "This month" | "Older";

export function dateGroup(iso: string, now = new Date()): DateGroup {
  const today = startOfDay(now);
  const t = new Date(iso).getTime();
  if (t >= today) return "Today";
  if (t >= today - DAY) return "Yesterday";
  if (t >= today - 6 * DAY) return "This week";
  if (t >= today - 30 * DAY) return "This month";
  return "Older";
}
