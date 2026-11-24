import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineOf, median, overBaseline, UsageLog, usageQueryOf, type UsageEntry } from "./usage-log.js";
import { findSavings } from "./savings.js";
import { RunGuard, RunWatch } from "./agent-watch.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-24T12:00:00Z");
const end = (o: Partial<UsageEntry> & { requests: number }): UsageEntry => ({ at: T0, level: "info", executor: "opencode", size: "S", event: "run-end", task: "t", ...o, numbers: { requests: o.requests, ok: 1, paid: 1, ...(o.numbers ?? {}) } });

test("usage log: append, filter (level, executor, grep, since), totals, 14-day rotation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kesher-usage-"));
  let now = T0;
  const log = new UsageLog(dir, () => now);
  try {
    writeFileSync(join(dir, "usage-2026-11-01.jsonl"), `${JSON.stringify({ at: T0 - 23 * DAY, level: "info", executor: "opencode", event: "run-end" })}\n`);
    await log.append({ level: "info", executor: "opencode", task: "a", event: "run-end", numbers: { requests: 10, minutes: 4 }, why: "done" });
    await log.append({ level: "warning", executor: "antigravity", task: "b", event: "anomaly", why: "Heavy step: read (30000 characters)\nnext line" });
    await log.append({ level: "suggestion", executor: "opencode", event: "saving", why: "Route S tasks free first" });
    assert.ok(!readdirSync(dir).includes("usage-2026-11-01.jsonl"), "the old file is gone");
    assert.equal((await log.read()).length, 3);
    assert.deepEqual((await log.read({ level: "warning" })).map((e) => e.task), ["b"]);
    assert.equal((await log.read({ executor: "opencode" })).length, 2);
    assert.equal((await log.read({ grep: "HEAVY" })).length, 1);
    assert.equal((await log.read({ level: "suggestion" }))[0]!.why, "Route S tasks free first");
    assert.ok(!(await log.read({ grep: "heavy" }))[0]!.why!.includes("\n"));
    now += DAY;
    assert.equal((await log.read({ since: now })).length, 0);
    const t = await log.totals();
    assert.deepEqual(t.find((d) => d.executor === "opencode")!.runs, 1);
    assert.deepEqual([t.find((d) => d.executor === "antigravity")!.warnings, t.find((d) => d.executor === "opencode")!.suggestions], [1, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage log: the query string is parsed safely", () => {
  assert.deepEqual(usageQueryOf({ level: "warning", executor: "opencode", since: "5", grep: "x", limit: "20" }), { level: "warning", executor: "opencode", since: 5, grep: "x", limit: 20 });
  assert.deepEqual(usageQueryOf({ level: "bogus", since: "abc" }), {});
});

test("meter: the baseline is the median of the last runs per executor and size; over twice it is an anomaly", () => {
  assert.equal(median([1, 9, 5]), 5);
  const runs = [10, 12, 14, 11, 13].map((requests) => end({ requests }));
  const base = baselineOf([...runs, end({ requests: 500, size: "L" })], "opencode", "S")!;
  assert.equal(base.requests, 12);
  assert.equal(baselineOf(runs.slice(0, 2), "opencode", "S"), undefined, "too few runs to judge by");
  assert.equal(overBaseline({ requests: 24 }, base), undefined);
  assert.match(overBaseline({ requests: 25 }, base)!, /25 requests, over 2x the usual 12/);
});

test("guard: a heavy step and a run far over the usual are flagged to the watchdog (nothing is stopped)", async () => {
  let now = 0;
  const flags: string[] = [];
  const seen: string[][] = [];
  const g = new RunGuard(
    new RunWatch({ stallMs: 1e9, maxRequests: 1000, ceilingMs: 1e12 }, () => now),
    { log: () => undefined, anomaly: (d) => flags.push(d), look: async (o) => (seen.push(o.flags), { state: "stuck" as const, why: "re-reading the same big file" }) },
    () => now,
    1,
    (n) => (n > 3 ? "4 requests, over 2x the usual 1 for this size" : undefined),
  );
  g.step({ tool: "read_file", args: { path: "a", text: "x".repeat(25_000) } });
  for (let i = 0; i < 3; i++) g.step({ tool: "t", args: i });
  assert.equal(flags.length, 2);
  assert.match(flags[0]!, /^Heavy step: read_file \(\d+ characters of input\)/);
  assert.match(flags[1]!, /^Over the usual/);
  now += 5;
  await g.tick();
  assert.equal(seen[0]!.length, 2);
  assert.equal(g.stopped, undefined);
});

test("savings finder: free first, the same failure again, a rejected costly run, heavy steps again", () => {
  const free = [8, 10].map((requests) => end({ requests, numbers: { requests, ok: 1, paid: 0 } }));
  const paid = [30, 34, 40].map((requests) => end({ requests }));
  const fails = [1, 2, 3].map((n) => end({ requests: 5, task: "x", at: T0 + n, numbers: { requests: 5, ok: 0, paid: 1 }, why: "failed: The agent failed: 429 too many" }));
  const review: UsageEntry = { at: T0, level: "warning", executor: "opencode", task: "big", event: "review", why: "reject: wrong file" };
  const big = end({ requests: 60, task: "big" });
  const heavy = [1, 2, 3].map((n): UsageEntry => ({ at: T0 + n, level: "warning", executor: "antigravity", event: "anomaly", why: "Heavy step: read_file (40000 characters of input)" }));
  const s = findSavings([...free, ...paid, ...fails, review, big, ...heavy]);
  assert.equal(s.every((x) => x.level === "suggestion" && x.event === "saving"), true);
  assert.ok(s.some((x) => x.size === "S" && /free or local/.test(x.why!) && x.numbers!.saved! > 0));
  assert.ok(s.some((x) => x.task === "x" && /Stop retrying/.test(x.why!)));
  assert.ok(s.some((x) => x.task === "big" && /rejected a run after 60 requests/.test(x.why!)));
  assert.ok(s.some((x) => /very large input/.test(x.why!)));
  assert.deepEqual(findSavings([end({ requests: 5 })]), []);
});
