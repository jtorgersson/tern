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
  if (t >= today) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (t >= today - DAY) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (t >= today - 6 * DAY) return d.toLocaleDateString([], { weekday: "short" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { day: "numeric", month: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

/** Full reader timestamp. */
export function longTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
