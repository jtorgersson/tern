// Calendar time helpers. CalEvent.start/end are local wall-clock ISO strings without offset
// ("2026-10-07T09:00:00"), so `new Date(s)` parses them in the machine's zone.
import type { CalEvent, Recurrence, Weekday } from "$lib/types";
import { dayMonth, hhmm, weekdayDayMonth, weekdayLong, word, startOfWeek as sow } from "./fmt";
export { startOfWeek, isoWeek } from "./fmt";

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

/** "09:05" (24-hour). */
export function hm(iso: string | Date): string {
  return hhmm(iso);
}

/** "09:00 – 10:30" */
export function timeRange(ev: Pick<CalEvent, "start" | "end" | "isAllDay">): string {
  if (ev.isAllDay) return word("allDay");
  return `${hm(ev.start)}–${hm(ev.end)}`;
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
  if (k === dayKey(now)) return word("today");
  if (k === dayKey(addDays(startOfDay(now), 1))) return word("tomorrow");
  if (k === dayKey(addDays(startOfDay(now), -1))) return word("yesterday");
  return weekdayLong(d);
}

export function dateLabel(d: Date): string {
  return dayMonth(d);
}

/** "Wed 8 Oct, 10:00 – 11:00 (1h)" — used in agent previews and the invite card. */
export function whenLabel(ev: Pick<CalEvent, "start" | "end" | "isAllDay">): string {
  const d = new Date(ev.start);
  const day = weekdayDayMonth(d);
  if (ev.isAllDay) {
    const days = Math.round(minutesBetween(ev.start, ev.end) / 1440);
    return days > 1 ? `${day} – ${weekdayDayMonth(new Date(new Date(ev.end).getTime() - 1))} · ${word("allDay")}` : `${day} · ${word("allDay")}`;
  }
  // Multi-day timed event: show both dates.
  if (dayKey(ev.start) !== dayKey(new Date(new Date(ev.end).getTime() - 1))) {
    return `${day} ${hm(ev.start)} – ${weekdayDayMonth(ev.end)} ${hm(ev.end)}`;
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

// ---------- period helpers ----------

export function addMonths(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth() + n, 1);
  // Keep the day of month where possible (31 Jan + 1 month → 28/29 Feb).
  const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  x.setDate(Math.min(d.getDate(), last));
  return x;
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Monday-first 6×7 grid covering the month (always 42 days so the layout never jumps). */
export function monthGrid(d: Date): Date[] {
  const first = sow(startOfMonth(d));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

/** Mon..Sun of the week containing `d`. */
export function weekDays(d: Date, includeWeekends = true): Date[] {
  const first = sow(d);
  return Array.from({ length: includeWeekends ? 7 : 5 }, (_, i) => addDays(first, i));
}

/** Minutes since local midnight of `day` (negative / >1440 when the time falls on another day). */
export function minutesIntoDay(iso: string, day: Date): number {
  return Math.round((new Date(iso).getTime() - startOfDay(day).getTime()) / 60_000);
}

export interface Placed<T> {
  item: T;
  /** Column index and total columns inside the overlap cluster (for side-by-side layout). */
  col: number;
  cols: number;
  top: number; // minutes from day start
  bottom: number;
}

/**
 * Lays out timed events of one day side by side where they overlap (classic calendar column packing).
 * Events are clipped to the day: [0, 1440].
 */
export function layoutDay<T extends Pick<CalEvent, "start" | "end">>(events: T[], day: Date, minHeightMins = 20): Placed<T>[] {
  const items = events
    .map((e) => {
      const top = Math.max(0, minutesIntoDay(e.start, day));
      const bottom = Math.min(1440, Math.max(top + minHeightMins, minutesIntoDay(e.end, day)));
      return { item: e, col: 0, cols: 1, top, bottom };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  // Build clusters of transitively overlapping events, assign columns greedily.
  let cluster: Placed<T>[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((p) => p.col + 1));
    for (const p of cluster) p.cols = cols;
    cluster = [];
  };
  for (const p of items) {
    if (cluster.length && p.top >= clusterEnd) flush();
    const taken = new Set(cluster.filter((o) => o.bottom > p.top).map((o) => o.col));
    let c = 0;
    while (taken.has(c)) c++;
    p.col = c;
    cluster.push(p);
    clusterEnd = Math.max(clusterEnd, p.bottom);
  }
  flush();
  return items;
}

/** Snap minutes to a grid step. */
export function snap(mins: number, step = 15): number {
  return Math.round(mins / step) * step;
}

// ---------- recurrence ----------

const WD: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export function weekdayOf(d: Date): Weekday {
  return WD[(d.getDay() + 6) % 7];
}

const WD_LABEL: Record<Weekday, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

/** "Every week on Tue, Thu until 18 Dec" */
export function recurrenceLabel(r: Recurrence | null | undefined): string {
  if (!r?.pattern) return "";
  const p = r.pattern;
  const n = p.interval || 1;
  const every = (unit: string) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);
  let s: string;
  switch (p.type) {
    case "daily":
      s = every("day");
      break;
    case "weekly": {
      const days = (p.daysOfWeek ?? []).map((d) => WD_LABEL[d]);
      const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri"];
      const isWeekdays = days.length === 5 && weekdays.every((d) => days.includes(d));
      s = isWeekdays && n === 1 ? "Every weekday" : `${every("week")}${days.length ? ` on ${days.join(", ")}` : ""}`;
      break;
    }
    case "absoluteMonthly":
      s = `${every("month")} on day ${p.dayOfMonth}`;
      break;
    case "relativeMonthly":
      s = `${every("month")} on the ${p.index ?? "first"} ${(p.daysOfWeek ?? []).map((d) => WD_LABEL[d]).join("/")}`;
      break;
    case "absoluteYearly":
    case "relativeYearly":
      s = every("year");
      break;
    default:
      s = "Repeats";
  }
  if (r.range?.type === "endDate" && r.range.endDate) s += ` until ${dayMonth(r.range.endDate + "T00:00:00")}`;
  else if (r.range?.type === "numbered" && r.range.numberOfOccurrences) s += `, ${r.range.numberOfOccurrences} times`;
  return s;
}

export type RepeatPreset = "none" | "daily" | "weekdays" | "weekly" | "biweekly" | "monthly" | "yearly";

/** Builds a Graph recurrence from a simple preset anchored on `start`. */
export function presetRecurrence(preset: RepeatPreset, start: Date, until: string | null = null): Recurrence | null {
  if (preset === "none") return null;
  const range: Recurrence["range"] = until ? { type: "endDate", startDate: dayKey(start), endDate: until } : { type: "noEnd", startDate: dayKey(start) };
  const wd = weekdayOf(start);
  switch (preset) {
    case "daily":
      return { pattern: { type: "daily", interval: 1 }, range };
    case "weekdays":
      return { pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday"], firstDayOfWeek: "monday" }, range };
    case "weekly":
      return { pattern: { type: "weekly", interval: 1, daysOfWeek: [wd], firstDayOfWeek: "monday" }, range };
    case "biweekly":
      return { pattern: { type: "weekly", interval: 2, daysOfWeek: [wd], firstDayOfWeek: "monday" }, range };
    case "monthly":
      return { pattern: { type: "absoluteMonthly", interval: 1, dayOfMonth: start.getDate() }, range };
    case "yearly":
      return { pattern: { type: "absoluteYearly", interval: 1, dayOfMonth: start.getDate(), month: start.getMonth() + 1 }, range };
  }
}

/** Reverse of presetRecurrence (best effort) so the composer can show the current rule as a preset. */
export function recurrencePreset(r: Recurrence | null | undefined): RepeatPreset | "custom" {
  if (!r?.pattern) return "none";
  const p = r.pattern;
  if (p.type === "daily" && (p.interval ?? 1) === 1) return "daily";
  if (p.type === "weekly") {
    const d = p.daysOfWeek ?? [];
    if ((p.interval ?? 1) === 1 && d.length === 5 && !d.includes("saturday") && !d.includes("sunday")) return "weekdays";
    if (d.length === 1 && (p.interval ?? 1) === 1) return "weekly";
    if (d.length === 1 && p.interval === 2) return "biweekly";
  }
  if (p.type === "absoluteMonthly" && (p.interval ?? 1) === 1) return "monthly";
  if (p.type === "absoluteYearly" && (p.interval ?? 1) === 1) return "yearly";
  return "custom";
}

export const SHOW_AS_LABEL: Record<CalEvent["showAs"], string> = {
  free: "Free",
  tentative: "Tentative",
  busy: "Busy",
  oof: "Out of office",
  workingElsewhere: "Working elsewhere",
  unknown: "",
};
