import { describe, expect, test } from "bun:test";
import { hhmm, isoWeek, setLocale, startOfWeek, weekdayShort } from "./fmt";

describe("fmt", () => {
  test("24-hour clock regardless of locale", () => {
    setLocale("en-GB");
    expect(hhmm(new Date(2026, 9, 6, 15, 5))).toBe("15:05");
    expect(hhmm(new Date(2026, 9, 6, 0, 0))).toBe("00:00");
    expect(hhmm(new Date(2026, 9, 6, 12, 0))).toBe("12:00");
    setLocale("sv-SE");
    expect(hhmm(new Date(2026, 9, 6, 23, 59))).toBe("23:59");
  });
  test("ISO weeks and Monday start", () => {
    expect(isoWeek(new Date(2026, 9, 6))).toBe(41);
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1);
    expect(isoWeek(new Date(2027, 0, 1))).toBe(53);
    expect(startOfWeek(new Date(2026, 9, 11)).getDate()).toBe(5); // Sun 11 Oct → Mon 5 Oct
    expect(startOfWeek(new Date(2026, 9, 5)).getDate()).toBe(5);
  });
  test("weekday names follow the language setting", () => {
    setLocale("sv-SE");
    expect(weekdayShort(new Date(2026, 9, 6)).toLowerCase()).toContain("tis");
    setLocale("en-GB");
    expect(weekdayShort(new Date(2026, 9, 6))).toBe("Tue");
  });
});
