import { test } from "node:test";
import assert from "node:assert/strict";
import { antigravityGroup, buildProviderQuotas, cleanProviderQuotas, nextUtcDay, shareLeft } from "./provider-quotas.js";

const NOW = Date.UTC(2026, 10, 27, 10, 0, 0);
const MIN = 60_000;

test("with nothing known every task agent is listed as unknown, nothing invented", () => {
  const rows = buildProviderQuotas({ now: NOW });
  assert.deepEqual(rows.map((r) => [r.id, r.state, r.bars.length]), [
    ["antigravity", "unknown", 0],
    ["ghostcli", "unknown", 0],
    ["opencode", "unknown", 0],
    ["gemini", "unknown", 0],
    ["claude", "unknown", 0],
    ["local", "unknown", 0],
  ]);
  assert.ok(rows.every((r) => r.readAt === undefined && r.until === undefined));
});

test("Antigravity: one bar per model group, the lowest share and the earliest reset", () => {
  const [ag] = buildProviderQuotas({
    now: NOW,
    inbox: {
      agQuota: {
        at: NOW - 3 * MIN,
        models: [
          { name: "Gemini 3 Pro (High)", left: 0.6, resetAt: NOW + 60 * MIN },
          { name: "Gemini 3 Pro (Low)", left: 0.4, resetAt: NOW + 30 * MIN },
          { name: "Gemini 3 Flash", left: 1 },
          { name: "Claude Sonnet 4.5", left: 0, resetAt: NOW + 90 * MIN },
        ],
      },
    },
  });
  assert.equal(ag!.readAt, NOW - 3 * MIN);
  assert.deepEqual(ag!.bars, [
    { label: "Gemini Pro", left: 0.4, resetAt: NOW + 30 * MIN },
    { label: "Gemini Flash", left: 1 },
    { label: "Claude / GPT", left: 0, resetAt: NOW + 90 * MIN },
  ]);
  // One group used up is "low" (others still work), not "out".
  assert.equal(ag!.state, "low");
  assert.equal(antigravityGroup("GPT-OSS 120B"), "Claude / GPT");
});

test("Antigravity: all used up is out; the plan's stop gives its time", () => {
  const rows = buildProviderQuotas({ now: NOW, inbox: { agQuota: { at: NOW, models: [{ name: "Gemini 3 Pro", left: 0 }] }, quota: { until: NOW + 5 * MIN } } });
  assert.equal(rows[0]!.state, "out");
  assert.equal(rows[0]!.until, NOW + 5 * MIN);
  const past = buildProviderQuotas({ now: NOW, inbox: { agQuota: { at: NOW, models: [{ name: "Gemini 3 Pro", left: 0.1 }] }, quota: { until: NOW - 1 } } });
  assert.equal(past[0]!.state, "low");
  assert.equal(past[0]!.until, undefined);
});

test("GhostCLI: today's runs from the recent list (UTC day, checks left out), totals and health", () => {
  const rows = buildProviderQuotas({
    now: NOW,
    inbox: {
      relay: {
        probes: 3,
        probesOk: 3,
        runs: 9,
        done: 6,
        partial: 1,
        failed: 2,
        rateLimited: 1,
        lastRateLimitAt: NOW - 3 * 60 * MIN,
        avgMinutes: 7.5,
        since: NOW - 2 * 86_400_000,
        health: { at: NOW - 10 * MIN, ok: true, ms: 1200, model: "ghostcli/claude-opus", note: "ok" },
        recent: [
          { at: NOW - 5 * MIN, id: "a", model: "m", status: "done", ms: 1 },
          { at: NOW - 6 * MIN, id: "p", model: "m", status: "probe-ok", ms: 1 },
          { at: NOW - 7 * MIN, id: "b", model: "m", status: "failed", ms: 1 },
          { at: NOW - 8 * MIN, id: "c", model: "m", status: "rate-limited", ms: 1 },
          { at: NOW - 11 * 60 * MIN, id: "d", model: "m", status: "done", ms: 1 },
        ],
      },
    },
  });
  const g = rows.find((r) => r.id === "ghostcli")!;
  assert.deepEqual(g.today, { runs: 3, done: 1, partial: 0, failed: 1, rateLimited: 1 });
  assert.equal(g.total!.runs, 9);
  assert.equal(g.avgMinutes, 7.5);
  assert.deepEqual(g.health, { ok: true, model: "ghostcli/claude-opus", ms: 1200, at: NOW - 10 * MIN });
  assert.equal(g.state, "ok");
  assert.equal(g.readAt, NOW - 5 * MIN);
});

test("OpenCode Go: today against the cap, used up comes back at the next UTC day; a 429 blocks", () => {
  const full = buildProviderQuotas({ now: NOW, inbox: { opencode: { ready: true, used: 10, models: [] }, opencodeDailyCap: 10 } }).find((r) => r.id === "opencode")!;
  assert.deepEqual(full.bars, [{ label: "day", used: 10, limit: 10, resetAt: nextUtcDay(NOW) }]);
  assert.equal(full.state, "out");
  const blocked = buildProviderQuotas({ now: NOW, inbox: { opencode: { ready: true, used: 1, until: NOW + 20 * MIN, models: [] }, opencodeDailyCap: 10 } }).find((r) => r.id === "opencode")!;
  assert.equal(blocked.state, "out");
  assert.equal(blocked.until, NOW + 20 * MIN);
  const off = buildProviderQuotas({ now: NOW, inbox: { opencode: { ready: false, used: 0, models: [] } } }).find((r) => r.id === "opencode")!;
  assert.equal(off.state, "off");
  assert.deepEqual(off.bars, [{ label: "day", used: 0 }]);
});

test("free services: Gemini first with its own icon, others by id; no limit stays without one", () => {
  const rows = buildProviderQuotas({ now: NOW, inbox: { free: [{ id: "openrouter", name: "OpenRouter", used: 12, limit: 50, trainsOnData: false }, { id: "gemini", name: "Gemini", used: 3, trainsOnData: true }] } });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.indexOf("gemini") < ids.indexOf("inbox-openrouter"));
  const gem = rows.find((r) => r.id === "gemini")!;
  assert.equal(gem.kind, "gemini");
  assert.deepEqual(gem.bars, [{ label: "day", used: 3 }]);
  assert.equal(rows.filter((r) => r.id === "gemini").length, 1);
  assert.equal(shareLeft(rows.find((r) => r.id === "inbox-openrouter")!.bars[0]!), 1 - 12 / 50);
});

test("Claude (subscription): 5-hour and weekly bars from Claude Code's reading; off with why when it cannot run", () => {
  const rows = buildProviderQuotas({ now: NOW, inbox: { claude: { installed: true, account: "subscription", used: 2, quota: { at: NOW - MIN, fiveHour: { usedPercentage: 85, resetsAt: NOW + 60 * MIN }, sevenDay: { usedPercentage: 30, resetsAt: NOW + 3 * 86_400_000 } } } } });
  const c = rows.find((r) => r.id === "claude")!;
  assert.equal(c.bars[0]!.label, "5h");
  assert.ok(Math.abs(c.bars[0]!.left! - 0.15) < 1e-9);
  assert.equal(c.state, "low");
  assert.deepEqual(c.today, { runs: 2 });
  const key = buildProviderQuotas({ now: NOW, inbox: { claude: { installed: true, account: "api-key", used: 0 } } }).find((r) => r.id === "claude")!;
  assert.equal(key.state, "off");
  assert.equal(key.offWhy, "api-key");
  assert.equal(c.name, "Claude (subscription)");
  assert.equal(c.readAt, NOW - MIN);
  const missing = buildProviderQuotas({ now: NOW, inbox: { claude: { installed: false, used: 0 } } }).find((r) => r.id === "claude")!;
  assert.deepEqual([missing.state, missing.offWhy, missing.bars.length], ["off", "not-installed", 0]);
  const out = buildProviderQuotas({ now: NOW, inbox: { claude: { installed: true, loggedIn: false, used: 0 } } }).find((r) => r.id === "claude")!;
  assert.deepEqual([out.state, out.offWhy], ["off", "signed-out"]);
});

test("local model: loaded shows only the file name, never its folder", () => {
  const path = process.platform === "win32" ? "C:\\Models\\qwen3-8b-q4.gguf" : "/srv/models/qwen3-8b-q4.gguf";
  const l = buildProviderQuotas({ now: NOW, local: { loaded: true, model: path } }).find((r) => r.id === "local")!;
  assert.equal(l.model, "qwen3-8b-q4");
  assert.equal(l.state, "ok");
  // Either separator is cut, whatever the platform the snapshot is built on.
  assert.equal(buildProviderQuotas({ now: NOW, local: { loaded: true, model: "D:\\x\\y\\m.gguf" } }).find((r) => r.id === "local")!.model, "m");
  assert.equal(buildProviderQuotas({ now: NOW, local: { loaded: false } }).find((r) => r.id === "local")!.state, "off");
});

test("free cloud helpers: only set-up ones, in the chat group, blocked until a time", () => {
  const rows = buildProviderQuotas({
    now: NOW,
    freeCloud: [
      { id: "fc-cloudflare", name: "Cloudflare Workers AI", configured: true, enabled: true, state: "limited", until: NOW + 15 * MIN, day: { used: 90, limit: 100 } },
      { id: "fc-nvidia", name: "NVIDIA", configured: false, enabled: true, state: "nokey", day: { used: 0, limit: 0 } },
      { id: "fc-zhipu", name: "Zhipu", configured: true, enabled: false, state: "off", day: { used: 0, limit: 0 } },
    ],
  });
  const chat = rows.filter((r) => r.group === "chat");
  assert.deepEqual(chat.map((r) => [r.id, r.state]), [["cloud-fc-cloudflare", "out"], ["cloud-fc-zhipu", "off"]]);
  assert.deepEqual(chat[0]!.bars, [{ label: "day", used: 90, limit: 100, resetAt: NOW + 15 * MIN }]);
  assert.deepEqual(chat[1]!.bars, [{ label: "day", used: 0 }]);
});

test("the cleaner keeps a built snapshot as it is", () => {
  const rows = buildProviderQuotas({ now: NOW, inbox: { agQuota: { at: NOW, models: [{ name: "Gemini 3 Pro", left: 0.5, resetAt: NOW + MIN }] }, opencode: { ready: true, used: 2, models: [] }, opencodeDailyCap: 8 }, local: { loaded: false } });
  assert.deepEqual(cleanProviderQuotas(JSON.parse(JSON.stringify(rows))), rows);
});

test("the cleaner drops bad rows and caps texts, numbers and counts", () => {
  const long = "x".repeat(500);
  const out = cleanProviderQuotas([
    { id: "bad id!", kind: "local", name: "a", state: "ok", bars: [] },
    { id: "ok", kind: "nope", name: "a", state: "ok", bars: [] },
    { id: "ok2", kind: "free", name: "", state: "ok", bars: [] },
    { id: "good", kind: "free", group: "evil", name: `${long}\n`, state: "weird", bars: [{ label: "day", left: 7, used: -3, limit: "9", resetAt: Number.NaN }, { label: "" }, ...Array.from({ length: 20 }, () => ({ label: "b", left: 0.5 }))], health: { ok: "yes", model: long, ms: 5, at: 9 }, avgMinutes: 1e9, model: long, readAt: -5, until: 1.5 },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, kind: "local", name: "n", state: "ok", bars: [] })),
  ]);
  const g = out[0]!;
  assert.equal(g.id, "good");
  assert.equal(g.group, "tasks");
  assert.equal(g.state, "unknown");
  assert.equal(g.name.length, 60);
  assert.deepEqual(g.bars[0], { label: "day", left: 1 });
  // Eight are read, the one without a label is dropped.
  assert.equal(g.bars.length, 7);
  assert.equal(g.health!.ok, false);
  assert.equal(g.health!.model.length, 60);
  assert.equal(g.avgMinutes, 10_000);
  assert.equal(g.readAt, undefined);
  assert.equal(g.until, 1);
  // At most 24 rows are read (the three bad ones among them are dropped).
  assert.equal(out.length, 21);
  assert.deepEqual(cleanProviderQuotas("nope"), []);
});

test("quota failover: an out provider's row says where its waiting work went; the cleaner keeps only names and counts", () => {
  const now = 1_800_000_000_000;
  const rows = buildProviderQuotas({ now, inbox: { quota: { until: now + 3_600_000 }, moves: [{ from: "antigravity", to: "ghostcli" }, { from: "antigravity", to: "ghostcli" }, { from: "antigravity", to: "opencode" }, { from: "gemini", to: "ghostcli" }] } });
  const ag = rows.find((r) => r.id === "antigravity")!;
  assert.equal(ag.state, "out");
  assert.deepEqual(ag.movedTo, [{ name: "GhostCLI", tasks: 2 }, { name: "OpenCode Go", tasks: 1 }]);
  assert.deepEqual(rows.find((r) => r.id === "gemini")!.movedTo, [{ name: "GhostCLI", tasks: 1 }]);
  assert.equal(rows.find((r) => r.id === "ghostcli")!.movedTo, undefined);
  const clean = cleanProviderQuotas([{ ...ag, movedTo: [{ name: "Ghost\nCLI", tasks: 2.7 }, { name: "", tasks: 1 }, { name: "x", tasks: -1 }, ...Array(9).fill({ name: "y", tasks: 1 })] }]);
  assert.deepEqual(clean[0]!.movedTo?.[0], { name: "Ghost CLI", tasks: 2 });
  assert.ok((clean[0]!.movedTo?.length ?? 0) <= 6);
});
