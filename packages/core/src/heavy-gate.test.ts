import { test } from "node:test";
import assert from "node:assert/strict";
import { HeavyGate, LowMemoryError, waitingFor } from "./heavy-gate.js";

const L = (n: string) => ({ en: n, he: `${n}-he` });
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

test("jobs run one at a time, in order, and the status names who waits", async () => {
  const gate = new HeavyGate();
  const order: string[] = [];
  let release!: () => void;
  const a = gate.run(L("a"), () => new Promise<void>((r) => (release = r)).then(() => void order.push("a")));
  const b = gate.run(L("b"), async () => void order.push("b"));
  const c = gate.run(L("c"), async () => void order.push("c"));
  await tick();
  assert.equal(gate.status().running?.en, "a");
  assert.deepEqual(gate.status().waiting.map((w) => w.en), ["b", "c"]);
  assert.equal(waitingFor(gate.runningLabel()!, false), "Waiting for: a");
  release();
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.deepEqual(gate.status(), { waiting: [] });
});

test("a failing job does not block the queue", async () => {
  const gate = new HeavyGate();
  const a = gate.run(L("a"), async () => {
    await tick();
    throw new Error("boom");
  });
  const b = gate.run(L("b"), async () => "ok");
  await assert.rejects(a, /boom/);
  assert.equal(await b, "ok");
});

test("a heavy job may start another one without waiting for itself", async () => {
  const gate = new HeavyGate();
  const v = await gate.run(L("outer"), () => gate.run(L("inner"), async () => 7));
  assert.equal(v, 7);
});

test("low memory refuses new jobs at once and queued ones at their turn", async () => {
  const gate = new HeavyGate();
  let release!: () => void;
  const a = gate.run(L("a"), () => new Promise<void>((r) => (release = r)));
  const b = gate.run(L("b"), async () => "never");
  await tick();
  gate.setPressure({ en: "low", he: "נמוך" });
  assert.equal(gate.status().lowMemory?.en, "low");
  await assert.rejects(gate.run(L("c"), async () => 1), LowMemoryError);
  release();
  await a;
  await assert.rejects(b, LowMemoryError);
  gate.setPressure(undefined);
  assert.equal(await gate.run(L("d"), async () => "fine"), "fine");
});

test("an aborted wait leaves the queue", async () => {
  const gate = new HeavyGate();
  let release!: () => void;
  const a = gate.run(L("a"), () => new Promise<void>((r) => (release = r)));
  const ctl = new AbortController();
  const b = gate.run(L("b"), async () => 1, ctl.signal);
  await tick();
  ctl.abort();
  await assert.rejects(b, /Cancelled/);
  assert.deepEqual(gate.status().waiting, []);
  release();
  await a;
});
