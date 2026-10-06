// Natural-language quick add ("Lunch with Anna tomorrow 12", "Styrelsemöte fre 14-15:30", "Dentist 14/10 09:00 1h",
// "Standup every weekday 09:15 teams"). English and Swedish. No AI involved: deterministic, instant, offline.
import { addDays, dayKey, startOfDay, type RepeatPreset } from "./cal";

export interface QuickAdd {
  subject: string;
  start: Date;
  end: Date;
  allDay: boolean;
  isOnline: boolean;
  isPrivate: boolean;
  location: string | null;
  repeat: RepeatPreset;
  /** Which parts were recognised (for the live preview under the input). */
  matched: { date: boolean; time: boolean; duration: boolean; repeat: boolean };
}

const WEEKDAYS: [RegExp, number][] = [
  [/(?<![\p{L}\d])(mon(day)?|må(n(dag)?)?)(?![\p{L}\d])/iu, 1],
  [/(?<![\p{L}\d])(tue(s(day)?)?|tis(dag)?)(?![\p{L}\d])/iu, 2],
  [/(?<![\p{L}\d])(wed(nesday)?|ons(dag)?)(?![\p{L}\d])/iu, 3],
  [/(?<![\p{L}\d])(thu(rs(day)?)?|tors?(dag)?)(?![\p{L}\d])/iu, 4],
  [/(?<![\p{L}\d])(fri(day)?|fre(dag)?)(?![\p{L}\d])/iu, 5],
  [/(?<![\p{L}\d])(sat(urday)?|lör(dag)?)(?![\p{L}\d])/iu, 6],
  [/(?<![\p{L}\d])(sun(day)?|sön(dag)?)(?![\p{L}\d])/iu, 0],
];

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, maj: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11,
};

function cut(text: string, m: RegExpMatchArray | null): string {
  if (!m || m.index == null) return text;
  return (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length)).replace(/\s{2,}/g, " ");
}

function parseTime(h: string, m?: string, ampm?: string): number | null {
  let hh = Number(h);
  const mm = m ? Number(m) : 0;
  if (Number.isNaN(hh) || hh > 24 || mm > 59) return null;
  if (ampm) {
    const p = ampm.toLowerCase();
    if (p.startsWith("p") && hh < 12) hh += 12;
    if (p.startsWith("a") && hh === 12) hh = 0;
  }
  return hh * 60 + mm;
}

export function parseQuickAdd(input: string, now = new Date(), defaultDurationMins = 30): QuickAdd | null {
  let text = ` ${input.trim()} `;
  if (!text.trim()) return null;
  const matched = { date: false, time: false, duration: false, repeat: false };

  // ---- recurrence ----
  let repeat: RepeatPreset = "none";
  const rep: [RegExp, RepeatPreset][] = [
    [/\b(every|varje)\s+(weekday|vardag)s?\b|\bweekdays\b|\bvardagar\b/i, "weekdays"],
    [/\b(every other|varannan)\s+(week|vecka)\b|\bbiweekly\b/i, "biweekly"],
    [/\b(every|varje)\s+(day|dag)\b|\bdaily\b|\bdagligen\b/i, "daily"],
    [/\b(every|varje)\s+(week|vecka)\b|\bweekly\b|\bveckovis\b/i, "weekly"],
    [/\b(every|varje)\s+(month|månad)\b|\bmonthly\b|\bmånadsvis\b/i, "monthly"],
    [/(?<![\p{L}])(every|varje)\s+(year|år)(?![\p{L}])|\byearly\b|\bannually\b|(?<![\p{L}])årligen(?![\p{L}])/iu, "yearly"],
  ];
  for (const [re, p] of rep) {
    const m = text.match(re);
    if (m) {
      repeat = p;
      text = cut(text, m);
      matched.repeat = true;
      break;
    }
  }
  // "every monday" / "varje måndag" → weekly on that day (the weekday itself is parsed below).
  const everyDay = text.match(/\b(every|varje)\s+(?=(mon|tue|wed|thu|fri|sat|sun|må|tis|ons|tor|fre|lör|sön))/iu);
  if (everyDay) {
    repeat = "weekly";
    text = cut(text, everyDay);
    matched.repeat = true;
  }

  // ---- date ----
  let day: Date | null = null;
  let m: RegExpMatchArray | null;
  if ((m = text.match(/\b(today|idag)\b/i))) {
    day = startOfDay(now);
    text = cut(text, m);
  } else if ((m = text.match(/(?<![\p{L}])(day after tomorrow|övermorgon)(?![\p{L}])/iu))) {
    day = addDays(startOfDay(now), 2);
    text = cut(text, m);
  } else if ((m = text.match(/\b(tomorrow|tmrw|imorgon|imorron)\b/i))) {
    day = addDays(startOfDay(now), 1);
    text = cut(text, m);
  } else if ((m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) {
    day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    text = cut(text, m);
  } else if ((m = text.match(/(?<![\d:])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d:])/))) {
    const y = m[3] ? Number(m[3].length === 2 ? "20" + m[3] : m[3]) : now.getFullYear();
    day = new Date(y, Number(m[2]) - 1, Number(m[1]));
    if (!m[3] && day.getTime() < startOfDay(now).getTime() - 30 * 86_400_000) day.setFullYear(y + 1);
    text = cut(text, m);
  } else if ((m = text.match(/\b(\d{1,2})(?:st|nd|rd|th|:e)?\s+(jan|feb|mar|apr|may|maj|jun|jul|aug|sep|oct|okt|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?\b/i))) {
    const y = m[3] ? Number(m[3]) : now.getFullYear();
    day = new Date(y, MONTHS[m[2].toLowerCase()], Number(m[1]));
    if (!m[3] && day.getTime() < startOfDay(now).getTime() - 30 * 86_400_000) day.setFullYear(y + 1);
    text = cut(text, m);
  } else if ((m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*[:.]\d)/i))) {
    day = new Date(now.getFullYear(), MONTHS[m[1].toLowerCase()], Number(m[2]));
    if (day.getTime() < startOfDay(now).getTime() - 30 * 86_400_000) day.setFullYear(now.getFullYear() + 1);
    text = cut(text, m);
  } else {
    const nextM = text.match(/\b(next|nästa)\s+(?=\w)/i);
    for (const [re, dow] of WEEKDAYS) {
      const wm = text.match(re);
      if (wm) {
        const base = startOfDay(now);
        let diff = (dow - base.getDay() + 7) % 7;
        if (diff === 0 && !nextM) diff = 0; // "monday" on a Monday = today
        if (nextM) diff = diff === 0 ? 7 : diff + (diff <= 0 ? 7 : 0);
        day = addDays(base, diff);
        text = cut(text, wm);
        if (nextM) text = cut(text, text.match(/\b(next|nästa)\s+/i));
        break;
      }
    }
  }
  if (day) matched.date = true;

  // ---- time (range first, then single) ----
  let startMin: number | null = null;
  let endMin: number | null = null;
  const timeTok = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?`;
  if ((m = text.match(new RegExp(String.raw`(?:\b(?:kl\.?|at|från)\s*)?(?<![\d/])${timeTok}\s*(?:-|–|to|till)\s*${timeTok}(?![\d/])`, "i")))) {
    const a = parseTime(m[1], m[2], m[3] ?? m[6]);
    const b = parseTime(m[4], m[5], m[6]);
    if (a != null && b != null && !(m[2] == null && m[5] == null && Number(m[1]) <= 12 && Number(m[4]) <= 12 && Number(m[1]) > 24)) {
      startMin = a;
      endMin = b <= a ? b + 12 * 60 : b;
      text = cut(text, m);
    }
  }
  if (startMin == null) {
    // "kl 14", "at 14:30", "14:30", "9.15", "3pm"; bare "14" only after kl/at or when nothing else would claim it.
    const re = new RegExp(String.raw`\b(?:kl\.?|at|klockan)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b|(?<![\d/.:-])\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b`, "i");
    if ((m = text.match(re))) {
      const t = m[1] != null ? parseTime(m[1], m[2], m[3]) : m[4] != null ? parseTime(m[4], m[5], m[6]) : parseTime(m[7], undefined, m[8]);
      if (t != null) {
        startMin = t;
        text = cut(text, m);
      }
    }
  }
  if (startMin == null && (m = text.match(/(?<![\d/.:-])\b(\d{1,2})\b(?![\d/.:-]|\s*(?:min|h|tim|st|nd|rd|th|:e|jan|feb|mar|apr|maj|may|jun|jul|aug|sep|okt|oct|nov|dec))/i))) {
    // A lone hour ("lunch tomorrow 12") when a date was recognised or the word is at the end.
    const h = Number(m[1]);
    if (h >= 6 && h <= 23 && (matched.date || m.index! + m[0].length >= text.length - 2)) {
      startMin = h * 60;
      text = cut(text, m);
    }
  }
  if (startMin != null) matched.time = true;

  // ---- duration ----
  let durMin: number | null = null;
  if ((m = text.match(/\b(\d+(?:[.,]\d+)?)\s*(h|hr|hrs|hour|hours|tim|timme|timmar|t)\b/i))) {
    durMin = Math.round(Number(m[1].replace(",", ".")) * 60);
    text = cut(text, m);
  } else if ((m = text.match(/\b(\d+)\s*(m|min|mins|minutes|minuter)\b/i))) {
    durMin = Number(m[1]);
    text = cut(text, m);
  }
  if (durMin) matched.duration = true;

  // ---- place & online ----
  let isOnline = false;
  if ((m = text.match(/\b(teams|online|video|digitalt|remote)\b/i))) {
    isOnline = true;
    text = cut(text, m);
  }
  let isPrivate = false;
  if ((m = text.match(/\b(private|privat)\b/i))) {
    isPrivate = true;
    text = cut(text, m);
  }
  let location: string | null = null;
  if ((m = text.match(/\s@\s*([^@]+?)\s*$/)) || (m = text.match(/\s(?:at|på|i)\s+((?![\d])[A-ZÅÄÖ][^,]*?)\s*$/))) {
    location = m[1].trim();
    text = cut(text, m);
  }

  // ---- assemble ----
  const subject = text.replace(/\s+(with|med)\s*$/i, "").replace(/[\s,.;:-]+$/, "").trim();
  const base = day ?? startOfDay(now);
  let allDay = false;
  let start: Date;
  let end: Date;
  if (startMin == null) {
    if (day && !durMin) {
      allDay = true;
      start = base;
      end = addDays(base, 1);
    } else {
      // No time: next half hour from now (today), or 09:00 on the given day.
      start = day ? new Date(base.getFullYear(), base.getMonth(), base.getDate(), 9, 0) : nextHalfHour(now);
      end = new Date(start.getTime() + (durMin ?? defaultDurationMins) * 60_000);
    }
  } else {
    start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(startMin / 60), startMin % 60);
    if (!day && start.getTime() < now.getTime() - 60_000) start = addDays(start, 1); // "call 9" at 15:00 → tomorrow 09:00
    end = endMin != null ? new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(endMin / 60), endMin % 60) : new Date(start.getTime() + (durMin ?? defaultDurationMins) * 60_000);
    if (endMin != null && !day && start.getTime() > now.getTime() && dayKey(start) !== dayKey(base)) end = addDays(end, 1);
    if (end <= start) end = new Date(start.getTime() + defaultDurationMins * 60_000);
  }
  if (!subject && !matched.date && !matched.time) return null;
  return { subject: subject || "(no title)", start, end, allDay, isOnline, isPrivate, location, repeat, matched };
}

function nextHalfHour(now: Date): Date {
  const x = new Date(now);
  x.setSeconds(0, 0);
  x.setMinutes(x.getMinutes() <= 30 ? 30 : 60);
  return x;
}
