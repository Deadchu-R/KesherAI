import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageLog, type UsageEntry } from "./usage-log.js";
import { getInboxUsage } from "./inbox-usage.js";

const T0 = new Date("2026-11-27T10:00:00Z").getTime();

const entry = (o: Partial<UsageEntry> & { executor: string; requests?: number }): Omit<UsageEntry, "at"> => ({
  level: "info",
  size: "S",
  event: "run-end",
  task: "t",
  numbers: { requests: o.requests ?? 1, ok: 1, paid: 1 },
  ...o,
});

test("inbox usage: empty log returns no meters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kesher-inbox-usage-empty-"));
  const log = new UsageLog(dir, () => T0);
  const meters = await getInboxUsage(log, () => T0);
  assert.equal(meters.length, 0);
});

test("inbox usage: one executor today shows runs, avg minutes and remaining label", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kesher-inbox-usage-one-"));
  const now = T0;
  const log = new UsageLog(dir, () => now);
  await log.append(entry({ executor: "opencode-go", at: T0, numbers: { requests: 2, ok: 1, paid: 1, minutes: 9 } }));
  await log.append(entry({ executor: "opencode-go", at: T0 + 60_000, numbers: { requests: 3, ok: 1, paid: 1, minutes: 11 } }));
  const meters = await getInboxUsage(log, () => T0 + 120_000);
  assert.equal(meters.length, 1);
  assert.equal(meters[0]!.executor, "opencode-go");
  assert.equal(meters[0]!.runsToday, 2);
  assert.equal(meters[0]!.avgMinutesToday, 10);
  assert.match(meters[0]!.remainingLabel, /% of the month$/);
});

test("inbox usage: antigravity uses week % label", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kesher-inbox-usage-anti-"));
  const log = new UsageLog(dir, () => T0);
  await log.append(entry({ executor: "antigravity-claude", at: T0, numbers: { requests: 1, ok: 1, paid: 1, minutes: 5 } }));
  const meters = await getInboxUsage(log, () => T0 + 60_000);
  assert.equal(meters.length, 1);
  assert.match(meters[0]!.remainingLabel, /% week$/);
});

test("inbox usage: ghostcli/openrouter uses daily cap label", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kesher-inbox-usage-ghost-"));
  const log = new UsageLog(dir, () => T0);
  await log.append(entry({ executor: "ghostcli", at: T0, requests: 14, numbers: { requests: 14, ok: 1, paid: 1, minutes: 9 } }));
  const meters = await getInboxUsage(log, () => T0 + 60_000);
  assert.equal(meters.length, 1);
  assert.equal(meters[0]!.remainingLabel, "14/500 today");
});