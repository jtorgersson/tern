import { describe, expect, test } from "bun:test";
import type { CalEvent } from "$lib/types";
import { busyMinutes, clockNote, freeGaps } from "./cal";

function ev(start: string, end: string, extra: Partial<CalEvent> = {}): CalEvent {
  return {
    id: start, accountId: "a", subject: "m", start, end, timeZone: "Europe/Stockholm", isAllDay: false, isCancelled: false,
    location: null, organizer: null, attendees: [], response: "organizer", showAs: "busy", isOnline: false, joinUrl: null,
    webLink: null, preview: "", seriesMasterId: null, responseRequested: false, calendarId: "", eventType: "singleInstance",
    reminderMinutes: null, sensitivity: "normal", importance: "normal", categories: [], ...extra,
  };
}

const day = new Date(2026, 9, 12); // Monday

describe("busyMinutes", () => {
  test("merges overlaps and clips to working hours", () => {
    const evs = [
      ev("2026-10-12T08:00:00", "2026-10-12T10:00:00"), // 1h inside 09–17
      ev("2026-10-12T09:30:00", "2026-10-12T11:00:00"), // overlaps, extends to 11
      ev("2026-10-12T16:30:00", "2026-10-12T18:00:00"), // 30m inside
    ];
    expect(busyMinutes(evs, day, 9 * 60, 17 * 60)).toBe(150);
  });
  test("ignores declined and free events", () => {
    const evs = [
      ev("2026-10-12T09:00:00", "2026-10-12T10:00:00", { response: "declined" }),
      ev("2026-10-12T10:00:00", "2026-10-12T11:00:00", { showAs: "free" }),
    ];
    expect(busyMinutes(evs, day, 9 * 60, 17 * 60)).toBe(0);
  });
});

describe("clockNote", () => {
  test("reports time left and a 15-minute heads-up", () => {
    const live = ev("2026-10-12T09:00:00", "2026-10-12T10:00:00");
    expect(clockNote(live, new Date(2026, 9, 12, 9, 42))).toEqual({ kind: "live", text: "18m left" });
    expect(clockNote(live, new Date(2026, 9, 12, 8, 48))).toEqual({ kind: "soon", text: "in 12m" });
    expect(clockNote(live, new Date(2026, 9, 12, 8, 30))).toBeNull();
  });
});

describe("freeGaps", () => {
  test("an all-day busy event leaves no focus time", () => {
    const evs = [ev("2026-10-12T00:00:00", "2026-10-13T00:00:00", { isAllDay: true, showAs: "oof" })];
    expect(freeGaps(evs, day, "09:00", "17:00")).toEqual([]);
  });
  test("returns the open stretch between meetings", () => {
    const evs = [ev("2026-10-12T09:00:00", "2026-10-12T10:00:00")];
    const gaps = freeGaps(evs, day, "09:00", "17:00", 60);
    expect(gaps.map((g) => [g.start.slice(11, 16), g.end.slice(11, 16), g.mins])).toEqual([["10:00", "17:00", 420]]);
  });
});
