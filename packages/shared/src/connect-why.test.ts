import { test } from "node:test";
import assert from "node:assert/strict";
import { addAttempt, attemptLines, cleanAttempts, connectChecks, connectTailscale, diagnoseConnection, shouldAutoTailscale, ATTEMPTS_MAX, type ConnectFacts } from "./connect-why.js";

const away: ConnectFacts = { internet: true, hub: true, direct: "fail", hasTailscalePath: true, canWake: true };

test("diagnoseConnection: the device's own internet comes first", () => {
  const v = diagnoseConnection({ ...away, internet: false, pcOnHub: "offline" });
  assert.equal(v.reason, "no-internet");
  assert.deepEqual(v.actions, ["retry"]);
});

test("diagnoseConnection: a direct answer is connected, a refused key is an expired pairing", () => {
  assert.equal(diagnoseConnection({ ...away, direct: "ok" }).reason, "connected");
  assert.equal(diagnoseConnection({ ...away, direct: "unauthorized", pcOnHub: "online" }).reason, "pairing-expired");
});

test("diagnoseConnection: what the hub says about the PC", () => {
  const r = diagnoseConnection({ ...away, pcOnHub: "restarting", pcUpdate: "0.6.498" });
  assert.equal(r.reason, "pc-restarting");
  assert.match(r.title.en, /0\.6\.498/);
  assert.match(r.title.he, /0\.6\.498/);
  assert.equal(diagnoseConnection({ ...away, pcOnHub: "asleep" }).reason, "pc-asleep");
  const off = diagnoseConnection({ ...away, pcOnHub: "offline" });
  assert.equal(off.reason, "pc-offline");
  assert.deepEqual(off.actions, ["wake", "hub", "retry"]);
});

test("diagnoseConnection: the PC is online but the direct link fails", () => {
  const ts = diagnoseConnection({ ...away, pcOnHub: "online" });
  assert.equal(ts.reason, "tailscale-off");
  assert.equal(ts.actions[0], "tailscale");
  const none = diagnoseConnection({ ...away, pcOnHub: "online", hasTailscalePath: false });
  assert.equal(none.reason, "no-route");
  assert.ok(!none.actions.includes("tailscale"), "no Tailscale button without a Tailscale address");
  assert.equal(diagnoseConnection({ ...away, pcOnHub: "online", addressChanged: true }).reason, "address-changed");
});

test("diagnoseConnection: the hub could not be asked", () => {
  assert.equal(diagnoseConnection(away).reason, "unknown");
  assert.equal(diagnoseConnection({ ...away, hasTailscalePath: false }).reason, "no-route");
  assert.ok(!diagnoseConnection({ ...away, canWake: false }).actions.includes("wake"), "no Wake button without Wake-on-LAN");
});

test("connectChecks: ✓ / ✕ / — per check, stamped", () => {
  const rows = connectChecks({ internet: true, pcOnHub: "asleep", direct: "unauthorized" }, 5);
  assert.deepEqual(rows.map((r) => `${r.id}:${r.state}`), ["internet:ok", "hub:unknown", "pc:fail", "direct:fail", "tailscale:unknown"]);
  assert.ok(rows.every((r) => r.at === 5));
});

test("shouldAutoTailscale: only away from home, PC not known to be away, once in 10 minutes", () => {
  const now = 1_000_000_000;
  assert.equal(shouldAutoTailscale(away, {}, now), true);
  assert.equal(shouldAutoTailscale({ ...away, pcOnHub: "online" }, {}, now), true);
  assert.equal(shouldAutoTailscale(away, { atHome: true }, now), false);
  assert.equal(shouldAutoTailscale({ ...away, pcOnHub: "restarting" }, {}, now), false);
  assert.equal(shouldAutoTailscale({ ...away, internet: false }, {}, now), false);
  assert.equal(shouldAutoTailscale({ ...away, hasTailscalePath: false }, {}, now), false);
  assert.equal(shouldAutoTailscale({ ...away, direct: "unauthorized" }, {}, now), false);
  assert.equal(shouldAutoTailscale(away, { lastTried: now - 60_000 }, now), false);
  assert.equal(shouldAutoTailscale(away, { lastTried: now - 11 * 60_000 }, now), true);
});

const noWait = async () => undefined;

test("connectTailscale: sends the broadcast, then finds the PC", async () => {
  const calls: string[] = [];
  let n = 0;
  const r = await connectTailscale({ plugin: { connect: async () => void calls.push("connect"), open: async () => void calls.push("open") }, probe: async () => ++n >= 3, wait: noWait });
  assert.deepEqual(r, { how: "broadcast", reachable: true });
  assert.deepEqual(calls, ["connect"]);
  assert.equal(n, 3);
});

test("connectTailscale: falls back to opening the app when the broadcast fails", async () => {
  const calls: string[] = [];
  const r = await connectTailscale({
    plugin: { connect: async () => { calls.push("connect"); throw new Error("NOT_INSTALLED"); }, open: async () => void calls.push("open") },
    probe: async () => false,
    wait: noWait,
    tries: 2,
  });
  assert.equal(r.how, "opened");
  assert.equal(r.reachable, false);
  assert.deepEqual(calls, ["connect", "open"]);
});

test("connectTailscale: neither works, or there is no plugin (outside the Android app)", async () => {
  const fail = async () => { throw new Error("no"); };
  const r = await connectTailscale({ plugin: { connect: fail, open: fail }, probe: async () => false, wait: noWait, tries: 1 });
  assert.equal(r.how, "none");
  assert.equal(r.error, "no");
  const waits: number[] = [];
  const bare = await connectTailscale({ probe: async () => true, wait: async (ms) => void waits.push(ms) });
  assert.deepEqual(bare, { how: "none", reachable: true });
  assert.deepEqual(waits, [], "no wait before the first check when nothing was sent");
});

test("the attempts log: cleaned, capped at 50, lines without addresses", () => {
  let log = cleanAttempts([{ at: 1, via: "home", ok: false, status: 0 }, { at: 2, via: "evil", ok: true }, "x", { at: 3, via: "tailscale", ok: true, status: 200, reason: "connected", url: "http://100.64.0.1" }]);
  assert.deepEqual(log, [{ at: 1, via: "home", ok: false }, { at: 3, via: "tailscale", ok: true, status: 200, reason: "connected" }]);
  for (let i = 0; i < 60; i++) log = addAttempt(log, { at: 10 + i, via: "hub", ok: false });
  assert.equal(log.length, ATTEMPTS_MAX);
  assert.equal(log.at(-1)?.at, 69);
  const [line] = attemptLines([{ at: Date.UTC(2026, 10, 27, 15, 50), via: "tailscale", ok: false, reason: "tailscale-off" }]);
  assert.equal(line, "2026-11-27T15:50:00Z tailscale fail tailscale-off");
});
