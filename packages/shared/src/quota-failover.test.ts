import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanFailoverOrder, failoverBlock, failoverOrder, failoverWhy, FAILOVER_DEFAULTS, MAX_QUOTA_MOVES, pickFailover, type ExecutorRoom, type FailoverTask } from "./quota-failover.js";

const task = (o: Partial<FailoverTask> = {}): FailoverTask => ({ kind: "code", size: "M", risk: "low", status: "waiting", executor: "auto", runBy: "antigravity", relayOk: true, trainOk: false, sensitive: false, ...o });
const open: ExecutorRoom = { open: true };
/** Every executor open, Antigravity out until 18:00 (as ms 1_000). */
const rooms = (o: Partial<Record<string, ExecutorRoom>> = {}) => ({
  antigravity: { open: false, until: 1_000, needsTap: true },
  ghostcli: { open: true, relay: true },
  opencode: open,
  gemini: { open: true, training: true },
  local: open,
  claude: open,
  opus: open,
  ...o,
});

test("an executor out of quota: the task moves to the first in the code order (GhostCLI), with when the first one is back", () => {
  assert.deepEqual(pickFailover(task(), rooms(), FAILOVER_DEFAULTS), { action: "move", to: "ghostcli", back: 1_000 });
});

test("the order goes on when the next one is out too: GhostCLI capped → OpenCode Go", () => {
  assert.deepEqual(pickFailover(task(), rooms({ ghostcli: { open: false, relay: true } }), FAILOVER_DEFAULTS), { action: "move", to: "opencode", back: 1_000 });
});

test("an executor with quota keeps its task", () => {
  assert.equal(pickFailover(task({ runBy: "opencode" }), rooms(), FAILOVER_DEFAULTS).action, "stay");
});

test("research follows its own order: Gemini out → GhostCLI, then Antigravity (which waits for the Run tap)", () => {
  const t = task({ kind: "research", runBy: "gemini" });
  assert.deepEqual(pickFailover(t, rooms({ gemini: { open: false, until: 5, training: true }, antigravity: { open: true, needsTap: true } }), FAILOVER_DEFAULTS), { action: "move", to: "ghostcli", back: 5 });
  const noGhost = rooms({ gemini: { open: false, training: true }, ghostcli: { open: false, relay: true }, antigravity: { open: true, needsTap: true } });
  assert.deepEqual(pickFailover(t, noGhost, FAILOVER_DEFAULTS), { action: "move", to: "antigravity" });
  // Never to OpenCode Go or the local model (they do not write research).
  assert.equal(pickFailover(t, rooms({ gemini: { open: false, training: true }, ghostcli: { open: false, relay: true } }), FAILOVER_DEFAULTS).action, "stay");
});

test("the task's own preference comes first, then the settings' order", () => {
  assert.deepEqual(failoverOrder({ kind: "code", executor: "opencode" }, FAILOVER_DEFAULTS), ["opencode", "ghostcli", "antigravity", "local"]);
  assert.deepEqual(failoverOrder({ kind: "code", executor: "auto" }, { ...FAILOVER_DEFAULTS, code: ["antigravity", "local"] }), ["antigravity", "local", "ghostcli", "opencode"]);
});

test("a hand-picked task: moved when 'move my tasks too' is on (default), asked about when it is off", () => {
  const t = task({ executor: "claude", runBy: "claude" });
  const r = rooms({ claude: { open: false, until: 9 } });
  assert.deepEqual(pickFailover(t, r, FAILOVER_DEFAULTS), { action: "move", to: "ghostcli", back: 9 });
  assert.deepEqual(pickFailover(t, r, { ...FAILOVER_DEFAULTS, moveManual: false }), { action: "ask", to: "ghostcli", back: 9 });
});

test("the failover switched off: nothing moves", () => {
  assert.equal(pickFailover(task(), rooms(), { ...FAILOVER_DEFAULTS, enabled: false }).action, "stay");
});

test("safety: a task not safe for a relay never goes to GhostCLI; one not safe for training never to the free Gemini key", () => {
  assert.deepEqual(pickFailover(task({ relayOk: false }), rooms(), FAILOVER_DEFAULTS), { action: "move", to: "opencode", back: 1_000 });
  const research = task({ kind: "research", runBy: "ghostcli", executor: "auto", relayOk: true, trainOk: false });
  assert.equal(failoverBlock(research, "gemini", { open: true, training: true }), "not safe for a service that may train");
  const r = rooms({ ghostcli: { open: false, relay: true }, antigravity: { open: false, needsTap: true } });
  assert.equal(pickFailover(research, r, FAILOVER_DEFAULTS).action, "stay");
});

test("safety: a security-sensitive task goes only to Antigravity", () => {
  const t = task({ runBy: "claude", executor: "claude", sensitive: true, relayOk: false });
  assert.equal(pickFailover(t, rooms({ claude: { open: false } }), FAILOVER_DEFAULTS).action, "stay");
  assert.deepEqual(pickFailover(t, rooms({ claude: { open: false }, antigravity: { open: true, needsTap: true } }), FAILOVER_DEFAULTS), { action: "move", to: "antigravity" });
});

test("no payment: an executor that would cost extra is never picked", () => {
  assert.deepEqual(pickFailover(task(), rooms({ ghostcli: { open: true, relay: true, extraCost: true } }), FAILOVER_DEFAULTS), { action: "move", to: "opencode", back: 1_000 });
  assert.equal(failoverBlock(task(), "opencode", { open: true, extraCost: true }), "opencode would cost extra money");
});

test("an L task never moves to OpenCode Go (big work stays with Antigravity, or GhostCLI when safe)", () => {
  assert.equal(pickFailover(task({ size: "L", runBy: "claude", relayOk: false }), rooms({ claude: { open: false } }), FAILOVER_DEFAULTS).action, "stay");
  assert.equal(pickFailover(task({ size: "L", runBy: "claude" }), rooms({ claude: { open: false } }), FAILOVER_DEFAULTS).action, "move");
});

test("the local model takes only small low-risk code tasks", () => {
  const r = rooms({ ghostcli: { open: false, relay: true }, opencode: { open: false } });
  assert.equal(pickFailover(task({ size: "M" }), r, FAILOVER_DEFAULTS).action, "stay");
  assert.deepEqual(pickFailover(task({ size: "S" }), r, FAILOVER_DEFAULTS), { action: "move", to: "local", back: 1_000 });
  assert.equal(pickFailover(task({ size: "S", risk: "medium" }), r, FAILOVER_DEFAULTS).action, "stay");
});

test("no bounce: a running task never moves, and a moved task never goes back to an executor it left", () => {
  assert.equal(pickFailover(task({ status: "running" }), rooms(), FAILOVER_DEFAULTS).action, "stay");
  assert.equal(pickFailover(task({ status: "needs-approval" }), rooms(), FAILOVER_DEFAULTS).action, "stay");
  // Moved Antigravity → GhostCLI; GhostCLI now capped and Antigravity back: it goes on to OpenCode Go, not back.
  const moved = task({ runBy: "ghostcli", movedFrom: { from: "antigravity" } });
  const r = rooms({ ghostcli: { open: false, relay: true }, antigravity: { open: true, needsTap: true } });
  assert.deepEqual(pickFailover(moved, r, FAILOVER_DEFAULTS), { action: "move", to: "opencode" });
  // And never to one it left earlier on the way.
  const twice = task({ runBy: "opencode", movedFrom: { from: "ghostcli", via: ["antigravity"] } });
  const r2 = rooms({ opencode: { open: false }, ghostcli: { open: true, relay: true }, antigravity: { open: true, needsTap: true } });
  assert.equal(pickFailover(twice, r2, FAILOVER_DEFAULTS).action, "stay");
});

test("quota back: a task that waits on its own executor with quota stays there (new tasks go to it by the routing)", () => {
  assert.equal(pickFailover(task({ runBy: "antigravity" }), rooms({ antigravity: { open: true, needsTap: true } }), FAILOVER_DEFAULTS).action, "stay");
});

test("Claude's own Opus agent is never moved", () => {
  assert.equal(pickFailover(task({ runBy: "opus", status: "queued" }), rooms({ opus: { open: false } }), FAILOVER_DEFAULTS).action, "stay");
});

test("a saved order is cleaned: unknown or wrong-kind executors dropped, missing ones kept at the end", () => {
  assert.deepEqual(cleanFailoverOrder("research", ["antigravity", "opencode", "x", "antigravity"]), ["antigravity", "gemini", "ghostcli"]);
  assert.deepEqual(cleanFailoverOrder("code", undefined), ["ghostcli", "opencode", "antigravity", "local"]);
});

test("a hand-picked executor is a preference: it moves when its quota is out (moveManual on by default)", () => {
  const t = task({ executor: "ghostcli", runBy: "ghostcli" });
  assert.deepEqual(pickFailover(t, rooms({ ghostcli: { open: false, until: 7, relay: true } }), FAILOVER_DEFAULTS), { action: "move", to: "opencode", back: 7 });
});

test("\"only this executor\" stays, whatever has quota, and never asks either", () => {
  const t = task({ executor: "ghostcli", runBy: "ghostcli", onlyThis: true });
  const r = rooms({ ghostcli: { open: false, relay: true } });
  assert.equal(pickFailover(t, r, FAILOVER_DEFAULTS).action, "stay");
  assert.equal(pickFailover(t, r, { ...FAILOVER_DEFAULTS, moveManual: false }).action, "stay");
});

test("the target with the most quota left goes first; the settings' order breaks a tie; a Run-tap target and the local model come last", () => {
  const r = rooms({ ghostcli: { open: true, relay: true, left: 0.2 }, opencode: { open: true, left: 0.8 }, local: { open: true, left: 0 } });
  assert.deepEqual(pickFailover(task(), r, FAILOVER_DEFAULTS), { action: "move", to: "opencode", back: 1_000 });
  const tie = rooms({ ghostcli: { open: true, relay: true, left: 0.5 }, opencode: { open: true, left: 0.5 } });
  assert.equal((pickFailover(task(), tie, FAILOVER_DEFAULTS) as { to: string }).to, "ghostcli");
  const tapOnly = rooms({ antigravity: { open: true, needsTap: true, left: 1 }, ghostcli: { open: true, relay: true, left: 0.1 }, opencode: { open: false }, local: { open: false } });
  assert.equal((pickFailover(task({ runBy: "local" }), tapOnly, FAILOVER_DEFAULTS) as { to: string }).to, "ghostcli");
});

test("no ping-pong: once its first executor is back, a moved task stays where it is", () => {
  const moved = task({ executor: "ghostcli", runBy: "opencode", movedFrom: { from: "ghostcli", via: [] } });
  assert.deepEqual(pickFailover(moved, rooms({ ghostcli: open }), FAILOVER_DEFAULTS), { action: "stay", why: "its executor has quota" });
  // And when the new one runs dry too, never back to the one it left.
  const r = rooms({ ghostcli: open, opencode: { open: false }, antigravity: open });
  assert.notEqual((pickFailover(moved, r, FAILOVER_DEFAULTS) as { to?: string }).to, "ghostcli");
});

test("a task moves at most three times without starting", () => {
  const r = rooms();
  assert.equal(pickFailover(task({ moves: MAX_QUOTA_MOVES - 1 }), r, FAILOVER_DEFAULTS).action, "move");
  assert.deepEqual(pickFailover(task({ moves: MAX_QUOTA_MOVES }), r, FAILOVER_DEFAULTS).action, "stay");
});

test("privacy rule: a sensitive, private or security-related task (hand-picked too) goes only to Antigravity, never to a relay or a training service", () => {
  const t = task({ executor: "ghostcli", runBy: "ghostcli", sensitive: true, relayOk: false, trainOk: false });
  const r = rooms({ ghostcli: { open: false, relay: true }, antigravity: { open: false, needsTap: true } });
  assert.equal(pickFailover(t, r, FAILOVER_DEFAULTS).action, "stay");
  const gem = task({ kind: "research", executor: "ghostcli", runBy: "ghostcli", relayOk: false, trainOk: false });
  assert.equal(pickFailover(gem, rooms({ ghostcli: { open: false, relay: true }, antigravity: { open: false } }), FAILOVER_DEFAULTS).action, "stay");
});

test("research whose web search is blocked goes to Antigravity (it searches by itself) while Gemini and GhostCLI wait", () => {
  const t = task({ kind: "research", runBy: "gemini" });
  const blocked = rooms({ gemini: { open: false, until: 9, training: true }, ghostcli: { open: false, until: 9, relay: true }, antigravity: { open: true, needsTap: true } });
  assert.deepEqual(pickFailover(t, blocked, FAILOVER_DEFAULTS), { action: "move", to: "antigravity", back: 9 });
  // Every executor blocked or out: it stays (the search retries with backoff).
  assert.equal(pickFailover(t, { ...blocked, antigravity: { open: false, needsTap: true } }, FAILOVER_DEFAULTS).action, "stay");
});

test("the note says why: the first executor's reason and what the new one has left", () => {
  assert.equal(failoverWhy("GhostCLI", { open: false, reason: "cooling down till 10:58" }, "OpenCode Go", { open: true, leftText: "47/60 left" }), "GhostCLI cooling down till 10:58, OpenCode Go has 47/60 left");
  assert.equal(failoverWhy("GhostCLI", undefined, "Gemini", { open: true }), "GhostCLI has no quota, Gemini has quota");
});

test("privacy rule: a task without security issues or private data may run on ANY provider, free ones that train on data included, picked by quota left", () => {
  const t = task({ kind: "research", runBy: "ghostcli", executor: "ghostcli", relayOk: true, trainOk: true, risk: "medium" });
  const r = rooms({ ghostcli: { open: false, relay: true }, gemini: { open: true, training: true, left: 0.9 }, antigravity: { open: true, needsTap: true } });
  assert.equal((pickFailover(t, r, FAILOVER_DEFAULTS) as { to: string }).to, "gemini");
  assert.equal(pickFailover({ ...t, trainOk: false }, r, FAILOVER_DEFAULTS).action, "move", "flagged: only Antigravity is left");
  assert.equal((pickFailover({ ...t, trainOk: false, sensitive: true }, r, FAILOVER_DEFAULTS) as { to: string }).to, "antigravity");
});
