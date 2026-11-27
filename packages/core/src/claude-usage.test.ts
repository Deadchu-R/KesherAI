import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeLine } from "./claude-exec.js";
import { ClaudeUsageWatch, MIN_GAP_MS, probeArgs } from "./claude-usage.js";

const LINE = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1795790000, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1795790000 }, seven_day: { utilization: 0.61, resetsAt: 1796240000 }, seven_day_overage_included: { utilization: 0.1, resetsAt: 1796240000 } } } });

test("a rate_limit_event with unifiedWindows gives one limit per window (five_hour, seven_day)", () => {
  const ev = parseClaudeLine(LINE);
  assert.deepEqual(ev, [
    { kind: "limit", window: "five_hour", used: 42, resetsAt: 1795790000_000, status: "allowed" },
    { kind: "limit", window: "seven_day", used: 61, resetsAt: 1796240000_000, status: "allowed" },
  ]);
  // Without the windows the old single-window reading still works.
  const one = parseClaudeLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1795790000, rateLimitType: "five_hour", utilization: 0.85 } }));
  assert.equal(one.length, 1);
  assert.equal((one[0] as { used: number }).used, 85);
});

test("probe arguments: smallest model, one turn, no tools that change or reach out", () => {
  const a = probeArgs("/s.json");
  assert.ok(a.includes("haiku") && a.includes("--max-turns"));
  for (const t of ["Bash", "Edit", "Write", "WebFetch", "WebSearch"]) assert.ok(a.includes(t));
});

test("the usage watch reads both windows, skips a second check inside the gap, and refuses an API key", async () => {
  const root = mkdtempSync(join(tmpdir(), "kesher-cu-"));
  try {
    let now = 1795780000_000;
    let runs = 0;
    const cli = { program: "claude", pre: [] };
    const w = new ClaudeUsageWatch({
      root, now: () => now, cli: () => cli,
      check: async () => ({ installed: true, loggedIn: true, account: "subscription" }),
      run: async (_c, _cwd, _args, onEvent) => { runs++; for (const e of parseClaudeLine(LINE)) onEvent(e); },
    });
    const r = await w.check(true);
    assert.equal(r.ok, true);
    assert.equal(r.quota?.fiveHour?.usedPercentage, 42);
    assert.equal(r.quota?.sevenDay?.usedPercentage, 61);
    now += 60_000;
    await w.check(true);
    assert.equal(runs, 1, "no second check inside the gap");
    now += MIN_GAP_MS;
    const key = new ClaudeUsageWatch({ root, now: () => now, cli: () => cli, check: async () => ({ installed: true, loggedIn: true, account: "api-key" }), run: async () => { runs++; } });
    const k = await key.check(true);
    assert.equal(k.ok, false);
    assert.match(k.why!, /API key/);
    assert.equal(runs, 1);
    const none = new ClaudeUsageWatch({ root, now: () => now, cli: () => undefined });
    assert.match((await none.check(true)).why!, /not installed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
