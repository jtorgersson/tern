import { describe, expect, test } from "bun:test";
import type { CalEvent } from "$lib/types";
import { computeInsights, heatBin, isMeeting } from "./insights";

const ME = "john@emcap.se";
let n = 0;
function ev(start: string, end: string, others: string[] = ["anna@x.se"], extra: Partial<CalEvent> = {}): CalEvent {
  return {
    id: `e${++n}`, accountId: "a", subject: "m", start, end, timeZone: "Europe/Stockholm", isAllDay: false, isCancelled: false,
    location: null, organizer: { name: "John", email: ME },
    attendees: others.map((e) => ({ addr: { name: e.split("@")[0], email: e }, type: "required" as const, response: "accepted" as const })),
    response: "organizer", showAs: "busy", isOnline: false, joinUrl: null, webLink: null, preview: "", seriesMasterId: null,
    responseRequested: true, calendarId: "", eventType: "singleInstance", reminderMinutes: null, sensitivity: "normal",
    importance: "normal", categories: [], ...extra,
  };
}

describe("insights", () => {
  // Anchor week: Mon 5 Oct – Sun 11 Oct 2026
  const anchor = new Date(2026, 9, 6);
  test("meeting time, back-to-back and focus in the anchor week", () => {
    const evs = [
      ev("2026-10-05T09:00:00", "2026-10-05T10:00:00"),
      ev("2026-10-05T10:00:00", "2026-10-05T10:30:00", ["anna@x.se", "bo@x.se"]), // back-to-back
      ev("2026-10-05T10:30:00", "2026-10-05T11:00:00"), // back-to-back again
      ev("2026-10-05T13:00:00", "2026-10-05T14:00:00", []), // solo: busy but not a meeting
      ev("2026-10-06T09:00:00", "2026-10-06T10:00:00", ["anna@x.se"], { response: "declined" }), // declined: ignored
    ];
    const i = computeInsights(evs, anchor, [ME], "09:00", "17:00", 12);
    expect(i.current.meetingMins).toBe(120);
    expect(i.current.meetings).toBe(3);
    expect(i.current.backToBack).toBe(2);
    expect(i.longestChainMins).toBe(120);
    // Monday 09–17: busy 09–11 and 13–14 → gaps 11–13 (2h) and 14–17 (3h) = 5h. Tue–Fri: 8h each.
    expect(i.current.focusMins).toBe(5 * 60 + 4 * 8 * 60);
    expect(i.people[0].email).toBe("anna@x.se");
    expect(i.people[0].meetings).toBe(3);
    expect(i.sizes).toEqual({ oneOnOne: 2, small: 1, large: 0 });
    expect(i.byHour[9]).toBe(60);
    expect(i.byHour[10]).toBe(60);
    expect(i.weeks.length).toBe(12);
    expect(i.weeks[11].days[0].meetingMins).toBe(120);
  });
  test("baseline averages the four previous weeks", () => {
    const evs = [ev("2026-09-28T09:00:00", "2026-09-28T11:00:00")]; // one 2h meeting the week before
    const i = computeInsights(evs, anchor, [ME]);
    expect(i.baseline.meetingMins).toBe(30);
  });
  test("helpers", () => {
    expect(isMeeting(ev("2026-10-05T09:00:00", "2026-10-05T10:00:00", []), new Set([ME]))).toBe(false);
    expect(heatBin(0, 300)).toBe(0);
    expect(heatBin(30, 300)).toBe(1);
    expect(heatBin(300, 300)).toBe(4);
  });
});
