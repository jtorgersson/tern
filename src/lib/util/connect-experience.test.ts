import { expect, test } from "bun:test";
import type { ConnectMessage } from "../connect";
import { briefSources, briefContext, parseBrief, matchesMessage, quotedText, MESSAGE_LIMIT, dayKey } from "./connect-experience";

const message = (id: string, text = "Launch on Monday"): ConnectMessage => ({ id, createdDateTime: "2026-10-11T10:00:00Z", from: { user: { id: "alex", displayName: "Alex Rivera" } }, body: { contentType: "text", content: text } });

test("find matches text, authors, subjects and HTML but never deleted messages", () => {
  expect(matchesMessage(message("1"), "  MONDAY ")).toBe(true);
  expect(matchesMessage(message("1"), "rivera")).toBe(true);
  expect(matchesMessage({ ...message("1"), subject: "Budget" }, "budget")).toBe(true);
  expect(matchesMessage({ ...message("1"), body: { contentType: "html", content: "<p>Tom &amp; Ana</p>" } }, "tom & ana")).toBe(true);
  expect(matchesMessage({ ...message("1"), deletedDateTime: "2026-10-12" }, "Monday")).toBe(false);
});

test("a removable quote is composed only for sending and contributes to the length limit", () => {
  const draft = "Sounds good";
  expect(quotedText(undefined, draft)).toBe(draft);
  expect(quotedText(message("1"), draft)).toBe('Alex Rivera wrote: “Launch on Monday”\n\nSounds good');
  expect(quotedText(message("1", "x".repeat(3000)), draft).length).toBeLessThan(2100);
  expect(quotedText(message("1"), "x".repeat(MESSAGE_LIMIT)).length).toBeGreaterThan(MESSAGE_LIMIT);
});

test("brief sources are recent, bounded, complete, and exclude deletions and activity", () => {
  const all = Array.from({ length: 60 }, (_, i) => message(String(i)));
  all.push({ ...message("deleted"), deletedDateTime: "2026-10-12" }, { ...message("system"), messageType: "systemEventMessage" });
  const sources = briefSources(all);
  expect(sources).toHaveLength(40);
  expect(sources[0].id).toBe("20");
  expect(sources.at(-1)?.id).toBe("59");
  expect(all[0].id).toBe("0");
  const bounded = briefSources([...all, message("huge", "x".repeat(19000))]);
  expect(briefContext(bounded).length).toBeLessThanOrEqual(18000);
  expect(bounded.some(m => m.id === "huge")).toBe(false);
  expect(JSON.parse(briefContext(sources))[0]).toMatchObject({ id: "20", author: "Alex Rivera", text: "Launch on Monday" });
});

test("brief cards reject nonexistent or missing evidence and malformed model output", () => {
  const valid = { summary: "Launch is agreed.", cards: [{ kind: "decision", text: "Launch Monday", sourceIds: ["1", "1"] }] };
  expect(parseBrief(JSON.stringify(valid), [message("1")]).cards[0].sourceIds).toEqual(["1"]);
  expect(parseBrief('```json\n' + JSON.stringify(valid) + '\n```', [message("1")]).summary).toBe(valid.summary);
  expect(() => parseBrief(JSON.stringify(valid), [message("other")])).toThrow("sources");
  for (const card of [null, { kind: "action", text: "Do it", sourceIds: [] }, { kind: "invented", text: "Do it", sourceIds: ["1"] }, { kind: "action", text: "", sourceIds: ["1"] }]) {
    expect(() => parseBrief(JSON.stringify({ summary: "Summary", cards: [card] }), [message("1")])).toThrow();
  }
  expect(() => parseBrief("not JSON", [])).toThrow();
  expect(() => parseBrief('{"summary": "", "cards": []}', [])).toThrow();
  expect(parseBrief('{"summary": "No decisions yet.", "cards": []}', []).cards).toEqual([]);
});

test("day boundaries use the viewer's local day and tolerate malformed dates", () => {
  const local = new Date(2026, 9, 11, 0, 1);
  const later = new Date(2026, 9, 11, 23, 59);
  expect(dayKey(local.toISOString())).toBe(dayKey(later.toISOString()));
  expect(dayKey(new Date(2026, 9, 12).toISOString())).not.toBe(dayKey(local.toISOString()));
  expect(dayKey("invalid")).toBe("unknown");
});
