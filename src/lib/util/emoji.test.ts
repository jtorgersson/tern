import { expect, test } from "bun:test";
import { insertEmoji } from "./emoji";

test("emoji insertion respects a selected range and returns the UTF-16 caret", () => {
  expect(insertEmoji("Hello Alex!", "👋", 6, 10)).toEqual({ value: "Hello 👋!", caret: 8 });
  expect(insertEmoji("Hi 👋 there", "😊", 6, 6)).toEqual({ value: "Hi 👋 😊there", caret: 8 });
  expect(insertEmoji("Thanks", "❤️")).toEqual({ value: "Thanks❤️", caret: 8 });
});

test("emoji insertion keeps drafts intact when the length limit would be exceeded", () => {
  expect(insertEmoji("abc", "😀", 3, 3, 4)).toEqual({ value: "abc", caret: 3 });
  expect(insertEmoji("abc", "😀", 1, 3, 4)).toEqual({ value: "a😀", caret: 3 });
});
