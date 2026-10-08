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

import { searchPage, searchConversation, conversationText, type ConnectSearchHit } from "./connect";

test("search handles empty responses and resolves channel replies ahead of chat IDs", () => {
  expect(searchPage({ value: [] })).toEqual({ hits: [], more: false });
  const hit: ConnectSearchHit = { hitId: "h", summary: "match", resource: { id: "reply", chatId: "chat", channelIdentity: { teamId: "team", channelId: "channel" }, webUrl: "https://teams.microsoft.com/l/message/channel/reply?parentMessageId=root" } };
  expect(searchConversation(hit)?.resource).toEqual({ kind: "replies", teamId: "team", channelId: "channel", messageId: "root" });
  expect(searchPage({ value: [{ hitsContainers: [{ hits: [hit], moreResultsAvailable: true }] }] })).toEqual({ hits: [hit], more: true });
  expect(searchConversation({ ...hit, resource: { id: "root", channelIdentity: { teamId: "team", channelId: "channel" }, webUrl: "https://teams.microsoft.com/?parentMessageId=root" } })?.resource.kind).toBe("channel");
  expect(searchConversation({ ...hit, resource: { id: "id" } })).toBeNull();
});

test("writing context excludes deleted messages and bounds the amount of history", () => {
  const messages: ConnectMessage[] = Array.from({ length: 100 }, (_, n) => ({ id: `${n}`, createdDateTime: `${n}`, from: { user: { id: "a", displayName: "Alex" } }, body: { contentType: "text", content: `message-${n}-` } }));
  messages[99].deletedDateTime = "today";
  const context = conversationText(messages);
  expect(context).not.toContain("message-0-");
  expect(context).not.toContain("message-99-");
  expect(context).toContain("Alex (98): message-98-");
  messages[98].body.content = "x".repeat(50000);
  expect(conversationText(messages).length).toBeLessThanOrEqual(18000);
});
