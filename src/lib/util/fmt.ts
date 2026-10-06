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

// ---------- time zones ----------

/** "15:05" of `d` as seen in IANA zone `tz` (24-hour). Falls back to local on an unknown zone. */
export function hhmmIn(d: Date | string, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date(d));
    const h = parts.find((p) => p.type === "hour")?.value ?? "00";
    const m = parts.find((p) => p.type === "minute")?.value ?? "00";
    return `${h === "24" ? "00" : h}:${m}`;
  } catch {
    return hhmm(d);
  }
}

/** Day offset of `tz` relative to local for the instant `d` (-1, 0, +1). */
export function dayShiftIn(d: Date | string, tz: string): number {
  try {
    const x = date(d);
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const there = f.format(x);
    const here = isoDate(x);
    return there === here ? 0 : there > here ? 1 : -1;
  } catch {
    return 0;
  }
}

/** Short label for a zone: "NYC", "LON"… from the city part, or the GMT offset. */
export function tzLabel(tz: string): string {
  try {
    const name = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value;
    if (name && !/^GMT[+-]?\d*$/.test(name) && name.length <= 5) return name;
    const city = tz.split("/").pop()?.replace(/_/g, " ") ?? tz;
    return city.length <= 9 ? city : city.slice(0, 3).toUpperCase();
  } catch {
    return tz;
  }
}

/** All IANA zones the runtime knows (falls back to a short list). */
export function allTimeZones(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (f) return f("timeZone");
  } catch {}
  return [
    "Europe/Stockholm", "Europe/London", "Europe/Berlin", "Europe/Helsinki", "America/New_York", "America/Chicago",
    "America/Denver", "America/Los_Angeles", "America/Sao_Paulo", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore",
    "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland", "UTC",
  ];
}
