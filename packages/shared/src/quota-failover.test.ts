import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanFailoverOrder, failoverBlock, failoverOrder, FAILOVER_DEFAULTS, pickFailover, type ExecutorRoom, type FailoverTask } from "./quota-failover.js";

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
