// Date/time formatting for the whole app. Swedish conventions throughout: 24-hour clock (never AM/PM),
// weeks start on Monday, ISO week numbers, day-before-month. The language of weekday/month names follows
// settings.ui.locale ("en-GB" default, or "sv-SE"); the clock and week rules do not change with it.

export type Locale = "en-GB" | "sv-SE";

let current: Locale = "en-GB";
const cache = new Map<string, Intl.DateTimeFormat>();

export function setLocale(l: string | null | undefined) {
  const next: Locale = l === "sv-SE" ? "sv-SE" : "en-GB";
  if (next !== current) {
    current = next;
    cache.clear();
  }
}

export function locale(): Locale {
  return current;
}

function f(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let d = cache.get(key);
  if (!d) {
    d = new Intl.DateTimeFormat(current, { ...opts, hourCycle: "h23" });
    cache.set(key, d);
  }
  return d;
}

function date(d: Date | string | number): Date {
  return d instanceof Date ? d : new Date(d);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "09:05" — always 24-hour, zero-padded (no Intl quirks like "24:00"). */
export function hhmm(d: Date | string | number): string {
  const x = date(d);
  if (Number.isNaN(x.getTime())) return "";
  return `${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

/** "Tue" / "tis" */
export function weekdayShort(d: Date | string): string {
  return f({ weekday: "short" }).format(date(d)).replace(/\.$/, "");
}

/** "Tuesday" / "tisdag" */
export function weekdayLong(d: Date | string): string {
  return f({ weekday: "long" }).format(date(d));
}

/** "6 Oct" / "6 okt" */
export function dayMonth(d: Date | string): string {
  return f({ day: "numeric", month: "short" }).format(date(d)).replace(/\.$/, "");
}

/** "6 Oct 2026" / "6 okt. 2026" */
export function dayMonthYear(d: Date | string): string {
  return f({ day: "numeric", month: "short", year: "numeric" }).format(date(d));
}

/** "6 October" / "6 oktober" */
export function dayMonthLong(d: Date | string): string {
  return f({ day: "numeric", month: "long" }).format(date(d));
}

/** "October 2026" / "oktober 2026" */
export function monthYear(d: Date | string): string {
  const s = f({ month: "long", year: "numeric" }).format(date(d));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "October" / "oktober" */
export function monthLong(d: Date | string): string {
  return f({ month: "long" }).format(date(d));
}

/** "Tue 6 Oct" / "tis 6 okt" */
export function weekdayDayMonth(d: Date | string): string {
  return `${weekdayShort(d)} ${dayMonth(d)}`;
}

/** "Tuesday 6 October" / "tisdag 6 oktober" */
export function weekdayDayMonthLong(d: Date | string): string {
  return `${weekdayLong(d)} ${dayMonthLong(d)}`;
}

/** "Tue 6 Oct 2026, 14:05" */
export function dateTimeLong(d: Date | string): string {
  const x = date(d);
  return `${weekdayShort(x)} ${dayMonthYear(x)}, ${hhmm(x)}`;
}

/** "2026-10-06" (local). */
export function isoDate(d: Date | string): string {
  const x = date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

/** ISO 8601 week number (weeks start Monday; week 1 contains 4 January). */
export function isoWeek(d: Date | string): number {
  const x = date(d);
  const t = new Date(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** Monday 00:00 of the week containing `d`. */
export function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - dow);
  return x;
}

/** Short word labels that depend on the language setting. */
export function word(key: "today" | "tomorrow" | "yesterday" | "week" | "allDay" | "now"): string {
  const sv = current === "sv-SE";
  switch (key) {
    case "today":
      return sv ? "Idag" : "Today";
    case "tomorrow":
      return sv ? "Imorgon" : "Tomorrow";
    case "yesterday":
      return sv ? "Igår" : "Yesterday";
    case "week":
      return sv ? "v." : "wk";
    case "allDay":
      return sv ? "heldag" : "all day";
    case "now":
      return sv ? "nu" : "now";
  }
}
