// Calendar insights: pure calculations over cached events (no UI, no I/O) so they are testable.
import type { CalEvent } from "$lib/types";
import { addDays, dayKey, isBusy, startOfDay } from "./cal";
import { startOfWeek } from "./fmt";

export interface DayStat {
  day: Date;
  key: string;
  meetingMins: number;
  meetings: number;
}

export interface WeekStat {
  start: Date;
  meetingMins: number;
  focusMins: number;
  meetings: number;
  backToBack: number;
}

export interface Person {
  email: string;
  name: string;
  mins: number;
  meetings: number;
}

export interface Insights {
  /** 12 weeks × 7 days, oldest week first, Monday first. */
  weeks: { start: Date; days: DayStat[] }[];
  weekly: WeekStat[];
  /** The anchor week (last of `weekly`) and the average of the 4 weeks before it. */
  current: WeekStat;
  baseline: { meetingMins: number; focusMins: number; meetings: number; backToBack: number };
  /** Meeting minutes per start hour 0–23 across the whole range. */
  byHour: number[];
  people: Person[];
  /** Meetings by size: 1:1, small group (2–5 others), large (6+ others). */
  sizes: { oneOnOne: number; small: number; large: number };
  /** Longest stretch of back-to-back meetings (minutes) in the anchor week. */
  longestChainMins: number;
  maxDayMins: number;
}

const BACK_TO_BACK_GAP = 5 * 60_000;
const DEEP_WORK_MIN = 60;

/** People in a meeting other than me (resources excluded). */
export function othersIn(e: CalEvent, me: Set<string>): { email: string; name: string }[] {
  const out = new Map<string, string>();
  if (e.organizer && !me.has(e.organizer.email.toLowerCase())) out.set(e.organizer.email.toLowerCase(), e.organizer.name);
  for (const a of e.attendees) {
    if (a.type === "resource") continue;
    const k = a.addr.email.toLowerCase();
    if (!k || me.has(k)) continue;
    if (!out.has(k) || !out.get(k)) out.set(k, a.addr.name);
  }
  return [...out.entries()].map(([email, name]) => ({ email, name: name || email }));
}

/** A meeting = busy timed event with at least one other person. */
export function isMeeting(e: CalEvent, me: Set<string>): boolean {
  return !e.isAllDay && isBusy(e) && othersIn(e, me).length > 0;
}

type Iv = [number, number];

function merge(ivs: Iv[]): Iv[] {
  const s = [...ivs].sort((a, b) => a[0] - b[0]);
  const out: Iv[] = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

const sum = (ivs: Iv[]) => ivs.reduce((n, [a, b]) => n + (b - a), 0);

function clip(e: CalEvent, lo: number, hi: number): Iv | null {
  const a = Math.max(lo, new Date(e.start).getTime());
  const b = Math.min(hi, new Date(e.end).getTime());
  return b > a ? [a, b] : null;
}

function hm(s: string): [number, number] {
  const [h, m] = s.split(":").map(Number);
  return [h || 0, m || 0];
}

export function computeInsights(events: CalEvent[], anchor: Date, myEmails: string[], workStart = "09:00", workEnd = "17:00", weeksBack = 12): Insights {
  const me = new Set(myEmails.map((e) => e.toLowerCase()));
  const lastWeek = startOfWeek(anchor);
  const first = addDays(lastWeek, -7 * (weeksBack - 1));
  const timed = events.filter((e) => !e.isAllDay && isBusy(e));
  const meetings = timed.filter((e) => isMeeting(e, me));
  const [wsH, wsM] = hm(workStart);
  const [weH, weM] = hm(workEnd);

  const weeks: Insights["weeks"] = [];
  const weekly: WeekStat[] = [];
  let maxDayMins = 0;
  let longestChainMins = 0;
  for (let w = 0; w < weeksBack; w++) {
    const ws = addDays(first, 7 * w);
    const days: DayStat[] = [];
    const wk: WeekStat = { start: ws, meetingMins: 0, focusMins: 0, meetings: 0, backToBack: 0 };
    for (let d = 0; d < 7; d++) {
      const day = addDays(ws, d);
      const lo = day.getTime();
      const hi = addDays(day, 1).getTime();
      const dayMeetings = meetings.filter((e) => clip(e, lo, hi)).sort((a, b) => a.start.localeCompare(b.start));
      const mIvs = merge(dayMeetings.map((e) => clip(e, lo, hi)!));
      const mins = Math.round(sum(mIvs) / 60_000);
      days.push({ day, key: dayKey(day), meetingMins: mins, meetings: dayMeetings.length });
      maxDayMins = Math.max(maxDayMins, mins);
      wk.meetingMins += mins;
      wk.meetings += dayMeetings.length;
      // Back-to-back: a meeting that starts within 5 min of the previous one ending.
      let chainStart = -1;
      let chainEnd = -1;
      for (const e of dayMeetings) {
        const s = new Date(e.start).getTime();
        const en = new Date(e.end).getTime();
        if (chainEnd >= 0 && s - chainEnd <= BACK_TO_BACK_GAP && s >= chainEnd - 60_000) {
          wk.backToBack++;
          chainEnd = Math.max(chainEnd, en);
        } else if (chainEnd >= 0 && s < chainEnd) {
          chainEnd = Math.max(chainEnd, en); // overlapping, same block
        } else {
          chainStart = s;
          chainEnd = en;
        }
        if (w === weeksBack - 1) longestChainMins = Math.max(longestChainMins, Math.round((chainEnd - chainStart) / 60_000));
      }
      // Focus: free gaps of ≥ 1 h inside working hours on weekdays (any busy event blocks time).
      if (d < 5) {
        const wlo = new Date(day.getFullYear(), day.getMonth(), day.getDate(), wsH, wsM).getTime();
        const whi = new Date(day.getFullYear(), day.getMonth(), day.getDate(), weH, weM).getTime();
        const busy = merge(timed.map((e) => clip(e, wlo, whi)).filter((x): x is Iv => !!x));
        let cursor = wlo;
        for (const [a, b] of [...busy, [whi, whi] as Iv]) {
          if ((a - cursor) / 60_000 >= DEEP_WORK_MIN) wk.focusMins += Math.round((a - cursor) / 60_000);
          cursor = Math.max(cursor, b);
        }
      }
    }
    weeks.push({ start: ws, days });
    weekly.push(wk);
  }

  const rangeLo = first.getTime();
  const rangeHi = addDays(lastWeek, 7).getTime();
  const inRange = meetings.filter((e) => clip(e, rangeLo, rangeHi));
  const byHour = Array.from({ length: 24 }, () => 0);
  const people = new Map<string, Person>();
  const sizes = { oneOnOne: 0, small: 0, large: 0 };
  for (const e of inRange) {
    const iv = clip(e, rangeLo, rangeHi)!;
    // Spread minutes over the hours the meeting covers.
    for (let t = iv[0]; t < iv[1]; ) {
      const d = new Date(t);
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
      const end = Math.min(next, iv[1]);
      byHour[d.getHours()] += Math.round((end - t) / 60_000);
      t = end;
    }
    const others = othersIn(e, me);
    const mins = Math.round((iv[1] - iv[0]) / 60_000);
    for (const o of others) {
      const p = people.get(o.email) ?? { email: o.email, name: o.name, mins: 0, meetings: 0 };
      p.mins += mins;
      p.meetings++;
      if (!p.name || p.name === p.email) p.name = o.name;
      people.set(o.email, p);
    }
    if (others.length === 1) sizes.oneOnOne++;
    else if (others.length <= 5) sizes.small++;
    else sizes.large++;
  }

  const current = weekly[weekly.length - 1];
  const prev = weekly.slice(-5, -1);
  const avg = (k: keyof Omit<WeekStat, "start">) => (prev.length ? Math.round(prev.reduce((n, w) => n + w[k], 0) / prev.length) : 0);
  return {
    weeks,
    weekly,
    current,
    baseline: { meetingMins: avg("meetingMins"), focusMins: avg("focusMins"), meetings: avg("meetings"), backToBack: avg("backToBack") },
    byHour,
    people: [...people.values()].sort((a, b) => b.mins - a.mins || b.meetings - a.meetings).slice(0, 8),
    sizes,
    longestChainMins,
    maxDayMins,
  };
}

/** "3h 30m", "45m", "0m" */
export function fmtMins(m: number): string {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** Sequential bin 0–4 for a heatmap cell (0 = none). */
export function heatBin(mins: number, max: number): number {
  if (mins <= 0) return 0;
  const m = Math.max(max, 240);
  return Math.min(4, Math.max(1, Math.ceil((mins / m) * 4)));
}

export { startOfDay };
