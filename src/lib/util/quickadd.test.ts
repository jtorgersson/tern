import { describe, expect, test } from "bun:test";
import { parseQuickAdd } from "./quickadd";

// Tue 6 Oct 2026, 10:12
const NOW = new Date(2026, 9, 6, 10, 12);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

describe("parseQuickAdd", () => {
  test("tomorrow + lone hour", () => {
    const q = parseQuickAdd("Lunch with Anna tomorrow 12", NOW)!;
    expect(q.subject).toBe("Lunch with Anna");
    expect(iso(q.start)).toBe("2026-10-07T12:00");
    expect(iso(q.end)).toBe("2026-10-07T12:30");
    expect(q.allDay).toBe(false);
  });
  test("swedish weekday + range", () => {
    const q = parseQuickAdd("Styrelsemöte fre 14-15:30", NOW)!;
    expect(q.subject).toBe("Styrelsemöte");
    expect(iso(q.start)).toBe("2026-10-09T14:00");
    expect(iso(q.end)).toBe("2026-10-09T15:30");
  });
  test("numeric date + time + duration", () => {
    const q = parseQuickAdd("Dentist 14/10 09:00 1h", NOW)!;
    expect(q.subject).toBe("Dentist");
    expect(iso(q.start)).toBe("2026-10-14T09:00");
    expect(iso(q.end)).toBe("2026-10-14T10:00");
  });
  test("recurring weekdays, online", () => {
    const q = parseQuickAdd("Standup every weekday 09:15 teams", NOW)!;
    expect(q.subject).toBe("Standup");
    expect(q.repeat).toBe("weekdays");
    expect(q.isOnline).toBe(true);
    expect(iso(q.start)).toBe("2026-10-07T09:15"); // 09:15 already passed today
  });
  test("date without time is all day", () => {
    const q = parseQuickAdd("Semester 20 dec", NOW)!;
    expect(q.allDay).toBe(true);
    expect(iso(q.start)).toBe("2026-12-20T00:00");
  });
  test("next monday + kl", () => {
    const q = parseQuickAdd("Möte med Marcus nästa måndag kl 10 @ Kontoret", NOW)!;
    expect(q.subject).toBe("Möte med Marcus");
    expect(iso(q.start)).toBe("2026-10-12T10:00");
    expect(q.location).toBe("Kontoret");
  });
  test("time already passed today rolls to tomorrow", () => {
    const q = parseQuickAdd("Call Marcus 9:00", NOW)!;
    expect(iso(q.start)).toBe("2026-10-07T09:00");
  });
  test("ISO date + 30min", () => {
    const q = parseQuickAdd("Review 2026-11-02 13.30 30min", NOW)!;
    expect(iso(q.start)).toBe("2026-11-02T13:30");
    expect(iso(q.end)).toBe("2026-11-02T14:00");
  });
  test("plain title is still an event", () => {
    const q = parseQuickAdd("Think", NOW)!;
    expect(q.subject).toBe("Think");
    expect(iso(q.start)).toBe("2026-10-06T10:30");
  });
  test("swedish tokens with å/ä/ö", () => {
    const a = parseQuickAdd("Lunch övermorgon 12", NOW)!;
    expect(a.subject).toBe("Lunch");
    expect(iso(a.start)).toBe("2026-10-08T12:00");
    const b = parseQuickAdd("Fest årligen 20/12", NOW)!;
    expect(b.repeat).toBe("yearly");
    expect(b.subject).toBe("Fest");
    const c = parseQuickAdd("Standup varje må 9", NOW)!;
    expect(c.repeat).toBe("weekly");
    expect(iso(c.start)).toBe("2026-10-12T09:00");
  });
  test("empty input", () => {
    expect(parseQuickAdd("   ", NOW)).toBeNull();
  });
});
