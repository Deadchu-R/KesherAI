import { test } from "node:test";
import assert from "node:assert/strict";
import { keepSelection, selectionOf, TEXT_HELPER_MAX } from "./text-helper.js";

test("a selection is kept for its window, cut to the limit, and forgotten after ten minutes", () => {
  const t0 = 1_000_000;
  const id = keepSelection("hello", t0);
  assert.equal(selectionOf(id, t0 + 1000), "hello");
  assert.equal(selectionOf(id, t0 + 11 * 60_000), undefined);
  assert.equal(selectionOf("nope", t0), undefined);
  const long = keepSelection("x".repeat(TEXT_HELPER_MAX + 50), t0);
  assert.equal(selectionOf(long, t0)!.length, TEXT_HELPER_MAX);
});

test("no more than 30 selections wait at once", () => {
  const t0 = 2_000_000;
  const first = keepSelection("first", t0);
  for (let i = 0; i < 30; i++) keepSelection(`s${i}`, t0);
  assert.equal(selectionOf(first, t0), undefined);
});
