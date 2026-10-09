import { expect, test } from "bun:test";
import { chatTitle, chatUnread, readCursor, unreadMessages, mergeMessages, type ConnectMessage } from "./connect";

test("unread chats combine Teams receipts with Tern reading and compare real instants", () => {
  const chat = { id: "c", topic: null, chatType: "oneOnOne",
    viewpoint: { lastMessageReadDateTime: "2026-10-09T10:00:00Z" },
    lastMessagePreview: { createdDateTime: "2026-10-09T12:05:00+02:00", from: { user: { id: "other", displayName: "Alex" } } },
  };
  expect(chatUnread(chat, "ms-me")).toBe(true);
  expect(chatUnread(chat, "ms-me", "2026-10-09T10:05:00Z")).toBe(false);
  expect(chatUnread(chat, "ms-me", "2026-10-09T09:00:00Z")).toBe(true);
  expect(chatUnread({ ...chat, viewpoint: { lastMessageReadDateTime: "2026-10-09T10:06:00Z" } }, "ms-me", "2026-10-09T10:05:00Z")).toBe(false);
  expect(chatUnread(chat, "ms-other")).toBe(false);
  expect(chatUnread({ ...chat, viewpoint: undefined }, "ms-me")).toBe(false);
  expect(chatUnread({ ...chat, lastMessagePreview: null }, "ms-me")).toBe(false);
  expect(readCursor("invalid", null, "2026-10-09T10:00:00Z")).toBe(Date.parse("2026-10-09T10:00:00Z"));
});

test("new-message boundaries exclude my sends, deleted messages, and system events", () => {
  const message = (id: string, user: string, at: string): ConnectMessage => ({ id, from: { user: { id: user, displayName: user } }, createdDateTime: at, body: { contentType: "text", content: id } });
  const messages = [message("read", "other", "2026-10-09T10:00:00Z"),
    message("mine", "me", "2026-10-09T10:01:00Z"),
    { ...message("deleted", "other", "2026-10-09T10:02:00Z"), deletedDateTime: "2026-10-09T10:03:00Z" },
    { ...message("activity", "other", "2026-10-09T10:03:00Z"), messageType: "systemEventMessage" },
    message("new", "other", "2026-10-09T12:04:00+02:00")];
  expect(unreadMessages(messages, "ms-me", readCursor("2026-10-09T10:00:00Z")).map(m => m.id)).toEqual(["new"]);
});

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
