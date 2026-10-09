import { expect, test } from "bun:test";
import { parsePins, pinKey } from "./pins";

test("pins stay scoped to account and channel team", () => {
  expect(pinKey("a", { kind: "chat", chatId: "x" })).not.toBe(pinKey("b", { kind: "chat", chatId: "x" }));
  expect(pinKey("a", { kind: "channel", teamId: "a", channelId: "x" })).not.toBe(pinKey("a", { kind: "channel", teamId: "b", channelId: "x" }));
});

test("restore discards invalid, duplicate, and unsupported pins", () => {
  const pin = { accountId: "a", conversation: { title: "Finance", resource: { kind: "chat" as const, chatId: "x" } } };
  expect(parsePins(JSON.stringify([null, {}, pin, pin, { ...pin, conversation: { title: "Bad", resource: { kind: "teams" } } }]))).toEqual([pin]);
  expect(parsePins("broken")).toEqual([]);
  expect(parsePins("{}")).toEqual([]);
});
