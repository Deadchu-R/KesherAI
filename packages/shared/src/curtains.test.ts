import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultOpen, isOpen, LONG_SECTION, parseCurtains, serializeCurtains, toggled } from "./curtains.js";

test("defaults: active groups open, Done and Failed closed, long work-list sections closed", () => {
  assert.equal(defaultOpen("t:active:agy"), true);
  assert.equal(defaultOpen("t:done:agy"), false);
  assert.equal(defaultOpen("t:failed:local"), false);
  assert.equal(defaultOpen("wl:Now", LONG_SECTION), true);
  assert.equal(defaultOpen("wl:Later", LONG_SECTION + 1), false);
});

test("toggling flips the shown state and keeps the old store", () => {
  const a = {};
  const b = toggled(a, "t:done:pc");
  assert.equal(isOpen(b, "t:done:pc"), true);
  assert.deepEqual(a, {});
  assert.equal(isOpen(toggled(b, "t:done:pc"), "t:done:pc"), false);
});

test("search forces every curtain open", () => {
  assert.equal(isOpen({ "t:active:pc": false }, "t:active:pc", 0, true), true);
});

test("a bad stored text gives an empty store; non-booleans are dropped", () => {
  assert.deepEqual(parseCurtains("{oops"), {});
  assert.deepEqual(parseCurtains("[1]"), {});
  assert.deepEqual(parseCurtains(null), {});
  assert.deepEqual(parseCurtains('{"a":true,"b":"x"}'), { a: true });
  assert.deepEqual(parseCurtains(serializeCurtains({ k: false })), { k: false });
});
