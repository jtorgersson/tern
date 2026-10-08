import { expect, test } from "bun:test";
import { chatTitle, mergeMessages, type ConnectMessage } from "./connect";

test("chat names prefer the topic and exclude the current user from unnamed chats", () => {
  const chat = { id: "c", topic: null, chatType: "oneOnOne", members: [
    { userId: "me", displayName: "Me" }, { userId: "other", displayName: "Alex" },
  ] };
  expect(chatTitle(chat, "ms-me")).toBe("Alex");
  expect(chatTitle({ ...chat, topic: "Launch" }, "ms-me")).toBe("Launch");
  expect(chatTitle({ id: "c", topic: null, chatType: "meeting" }, "ms-me")).toBe("Meeting chat");
});

test("overlapping pages replace edited/deleted messages without duplicating or dropping history", () => {
  const message = (id: string, date: string, content: string): ConnectMessage => ({ id, createdDateTime: date, body: { contentType: "text", content } });
  const old = message("old", "2026-01-01", "History");
  const original = message("recent", "2026-01-02", "Original");
  const edited = { ...original, body: { contentType: "text", content: "Edited" } };
  const merged = mergeMessages([original, old], [edited, message("new", "2026-01-03", "New")]);
  expect(merged.map(m => m.id)).toEqual(["old", "recent", "new"]);
  expect(merged[1].body.content).toBe("Edited");
  expect(mergeMessages(merged, [{ ...edited, deletedDateTime: "2026-01-04" }])[1].deletedDateTime).toBe("2026-01-04");
});
