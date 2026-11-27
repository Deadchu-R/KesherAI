import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProviderMeters } from "./inbox-usage-meter.js";
import type { UsageDay } from "./usage-log.js";

const day = (executor: string, runs: number, tokens: number, errors = 0, warnings = 0, minutes = 0): UsageDay => ({
  day: "2026-11-28",
  executor,
  runs,
  requests: runs * 2,
  tokens,
  minutes,
  warnings,
  errors,
  suggestions: 0,
});

test("buildProviderMeters formats active executors and skips idle ones", () => {
  const meters = buildProviderMeters([
    day("antigravity", 12, 4200, 0, 0, 8),
    day("local", 3, 800, 1, 0, 2),
    day("ghostcli", 0, 0),
  ]);
  assert.equal(meters.length, 2);
  assert.equal(meters[0].executor, "antigravity");
  assert.match(meters[0].line, /12 runs/);
  assert.match(meters[0].line, /4\.2k tokens/);
  assert.match(meters[0].line, /8 min/);
  assert.doesNotMatch(meters[0].line, /err|warn/);
  assert.equal(meters[1].executor, "local");
  assert.match(meters[1].line, /3 runs/);
  assert.match(meters[1].line, /1 err/);
});

test("buildProviderMeters returns empty list when nothing ran", () => {
  assert.deepEqual(buildProviderMeters([day("antigravity", 0, 0)]), []);
});

test("buildProviderMeters prefers errors over warnings in the line", () => {
  const [m] = buildProviderMeters([day("local", 1, 100, 2, 5)]);
  assert.match(m.line, /2 err/);
  assert.doesNotMatch(m.line, /warn/);
});