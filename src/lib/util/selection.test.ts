import { expect, test } from "bun:test";
import { selectRange } from "./selection";

test("range selection works in both directions and preserves other selections", () => {
  const ids = ["a", "b", "c", "d", "e"];
  expect([...selectRange(ids, new Set(["e"]), "b", "d")]).toEqual(["e", "b", "c", "d"]);
  expect([...selectRange(ids, new Set(), "d", "b")]).toEqual(["b", "c", "d"]);
});

test("stale anchors and targets cannot select unrelated messages", () => {
  expect([...selectRange(["a", "b"], new Set(), "gone", "b")]).toEqual(["b"]);
  expect([...selectRange(["a", "b"], new Set(["a"]), "a", "gone")]).toEqual(["a"]);
});
