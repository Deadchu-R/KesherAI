import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_BPS, MIN_SLOWED_BPS, busyMode, clampShare, slowedLimit } from "./busy.js";

const on = { enabled: true };

test("a chat answer slows, a game in Play pauses, and Play wins over a chat answer", () => {
  assert.equal(busyMode({ chat: false, playing: false }, on), "none");
  assert.equal(busyMode({ chat: true, playing: false }, on), "slowed");
  assert.equal(busyMode({ chat: false, playing: true }, on), "paused");
  assert.equal(busyMode({ chat: true, playing: true }, on), "paused");
});

test("the setting off, or a download marked Don't slow, is never slowed or paused", () => {
  const busy = { chat: true, playing: true };
  assert.equal(busyMode(busy, { enabled: false }), "none");
  assert.equal(busyMode(busy, on, true), "none");
});

test("the slowed limit is a share of the user's limit, or of the best speed seen when there is no limit", () => {
  assert.equal(slowedLimit(10_000_000, 99_000_000, 0.5), 5_000_000);
  assert.equal(slowedLimit(0, 20_000_000, 0.25), 5_000_000);
  assert.equal(slowedLimit(0, 0, 0.5), FALLBACK_BPS / 2);
  // Never a stall, and a silly share is kept sane.
  assert.equal(slowedLimit(100_000, 0, 0.5), MIN_SLOWED_BPS);
  assert.equal(slowedLimit(1_000_000, 0, 5), 1_000_000);
  assert.equal(clampShare("x"), 0.5);
  assert.equal(clampShare(0), 0.1);
});
