import { test } from "node:test";
import assert from "node:assert/strict";
import { keepSelection, selectionCut, selectionOf, TEXT_HELPER_MAX } from "./text-helper.js";

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

test("the user's own quick actions: a name and an instruction, cut, at most 12", async () => {
  const { cleanTextActions } = await import("./text-helper.js");
  assert.deepEqual(cleanTextActions([{ label: " Formal email ", prompt: "Rewrite as a formal email." }, { label: "", prompt: "x" }, { label: "x" }, 5, null]), [{ label: "Formal email", prompt: "Rewrite as a formal email." }]);
  assert.equal(cleanTextActions(Array.from({ length: 20 }, (_, i) => ({ label: `a${i}`, prompt: "p" }))).length, 12);
  assert.equal(cleanTextActions([{ label: "x".repeat(99), prompt: "p" }])[0]!.label.length, 40);
});

test("a selection longer than the limit is marked as cut", () => {
  assert.equal(selectionCut(keepSelection("short")), false);
  const long = keepSelection("x".repeat(TEXT_HELPER_MAX + 5));
  assert.equal(selectionCut(long), true);
  assert.equal(selectionOf(long)?.length, TEXT_HELPER_MAX);
});
