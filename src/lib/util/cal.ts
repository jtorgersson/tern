// Calendar time helpers. CalEvent.start/end are local wall-clock ISO strings without offset
// ("2026-10-07T09:00:00"), so `new Date(s)` parses them in the machine's zone.
import type { CalEvent } from "$lib/types";

const pad = (n: number) => String(n).padStart(2, "0");

/** Local ISO without offset, seconds zeroed. */
export function toLocalIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

/** "YYYY-MM-DD" of a local date. */
export function dayKey(d: Date | string): string {
  const x = typeof d === "string" ? new Date(d) : d;
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

export function startOfDay(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function minutesBetween(a: string | Date, b: string | Date): number {
  const ta = typeof a === "string" ? new Date(a).getTime() : a.getTime();
  const tb = typeof b === "string" ? new Date(b).getTime() : b.getTime();
  return Math.round((tb - ta) / 60_000);
}

export function hm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "09:00 – 10:30" */
export function timeRange(ev: Pick<CalEvent, "start" | "end" | "isAllDay">): string {
  if (ev.isAllDay) return "All day";
  return `${hm(ev.start)} – ${hm(ev.end)}`;
}

/** "1h 30m", "45m", "2 days" */
export function durationLabel(start: string, end: string, allDay = false): string {
  const mins = minutesBetween(start, end);
  if (allDay) {
    const days = Math.max(1, Math.round(mins / 1440));
    return days === 1 ? "All day" : `${days} days`;
  }
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "in 25 min", "in 2 h", "in 3 days", "now", "ended" */
export function untilLabel(ev: Pick<CalEvent, "start" | "end">, now = new Date()): string {
  const s = new Date(ev.start).getTime();
  const e = new Date(ev.end).getTime();
  const t = now.getTime();
  if (t >= s && t < e) return "now";
  if (t >= e) return "ended";
  const mins = Math.round((s - t) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `in ${mins} min`;
  const h = Math.round(mins / 60);
  if (h < 24) return `in ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "tomorrow" : `in ${d} days`;
}

/** Weekday + date, with "Today"/"Tomorrow" shortcuts. */
export function dayLabel(d: Date, now = new Date()): string {
  const k = dayKey(d);
  if (k === dayKey(now)) return "Today";
  if (k === dayKey(addDays(startOfDay(now), 1))) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "long" });
}

export function dateLabel(d: Date): string {
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** "Wed 8 Oct, 10:00 – 11:00 (1h)" — used in agent previews and the invite card. */
export function whenLabel(ev: Pick<CalEvent, "start" | "end" | "isAllDay">): string {
  const d = new Date(ev.start);
  const day = d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  if (ev.isAllDay) {
    const days = Math.round(minutesBetween(ev.start, ev.end) / 1440);
    return days > 1 ? `${day} – ${new Date(new Date(ev.end).getTime() - 1).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} · all day` : `${day} · all day`;
  }
  return `${day}, ${timeRange(ev)} (${durationLabel(ev.start, ev.end)})`;
}

export function isPast(ev: Pick<CalEvent, "end">, now = new Date()): boolean {
  return new Date(ev.end).getTime() <= now.getTime();
}

export function isNow(ev: Pick<CalEvent, "start" | "end">, now = new Date()): boolean {
  const t = now.getTime();
  return new Date(ev.start).getTime() <= t && t < new Date(ev.end).getTime();
}

export function overlaps(a: Pick<CalEvent, "start" | "end">, b: Pick<CalEvent, "start" | "end">): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Events that take up time (not declined, not cancelled, not marked free). */
export function isBusy(ev: CalEvent): boolean {
  return !ev.isCancelled && ev.response !== "declined" && ev.showAs !== "free";
}

/** Events sorted by start, all-day first. */
export function sortEvents(list: CalEvent[]): CalEvent[] {
  return [...list].sort((a, b) => Number(b.isAllDay) - Number(a.isAllDay) || a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

/** Timed events that intersect the given local day. */
export function eventsOnDay(list: CalEvent[], day: Date): CalEvent[] {
  const s = toLocalIso(startOfDay(day));
  const e = toLocalIso(addDays(startOfDay(day), 1));
  return sortEvents(list.filter((ev) => ev.start < e && ev.end > s));
}

export interface Gap {
  start: string;
  end: string;
  mins: number;
}

/** Free gaps ≥ minMins between busy timed events inside working hours on one day. */
export function freeGaps(dayEvents: CalEvent[], day: Date, workStart: string, workEnd: string, minMins = 60): Gap[] {
  const [wsH, wsM] = workStart.split(":").map(Number);
  const [weH, weM] = workEnd.split(":").map(Number);
  const ws = new Date(day.getFullYear(), day.getMonth(), day.getDate(), wsH || 9, wsM || 0);
  const we = new Date(day.getFullYear(), day.getMonth(), day.getDate(), weH || 17, weM || 0);
  const busy = dayEvents.filter((e) => !e.isAllDay && isBusy(e)).map((e) => ({ s: new Date(e.start).getTime(), e: new Date(e.end).getTime() })).sort((a, b) => a.s - b.s);
  const gaps: Gap[] = [];
  let cursor = ws.getTime();
  for (const b of busy) {
    if (b.s - cursor >= minMins * 60_000 && cursor < we.getTime()) {
      const end = Math.min(b.s, we.getTime());
      if (end - cursor >= minMins * 60_000) gaps.push({ start: toLocalIso(new Date(cursor)), end: toLocalIso(new Date(end)), mins: Math.round((end - cursor) / 60_000) });
    }
    cursor = Math.max(cursor, b.e);
  }
  if (we.getTime() - cursor >= minMins * 60_000) gaps.push({ start: toLocalIso(new Date(cursor)), end: toLocalIso(we), mins: Math.round((we.getTime() - cursor) / 60_000) });
  return gaps;
}

export function initialsOf(name: string, email: string): string {
  const n = (name || email.split("@")[0] || "?").trim();
  const parts = n.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export const RESPONSE_LABEL: Record<CalEvent["response"], string> = {
  none: "",
  organizer: "Organizer",
  accepted: "Accepted",
  tentativelyAccepted: "Tentative",
  declined: "Declined",
  notResponded: "Not responded",
};
