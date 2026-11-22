import { test } from "node:test";
import assert from "node:assert/strict";
import { HeavyGate } from "./heavy-gate.js";
import { assess, dropCaches, registerCache, startMemoryWatchdog, type MemoryReading } from "./memory-watchdog.js";

const MB = 1024 ** 2;
const r = (heapUsed: number, freeBytes = 50_000 * MB): MemoryReading => ({ heapUsed: heapUsed * MB, heapLimit: 1000 * MB, freeBytes, totalBytes: 100_000 * MB });

test("assess: relieve over 85% heap, refuse over 92% heap or under 10% free", () => {
  assert.deepEqual(assess(r(500)), { relieve: false });
  assert.equal(assess(r(860)).relieve, true);
  assert.equal(assess(r(860)).refuse, undefined);
  assert.ok(assess(r(930)).refuse);
  assert.ok(assess(r(100, 9_000 * MB)).refuse);
  assert.equal(assess(r(100, 11_000 * MB)).refuse, undefined);
});

test("the watchdog runs GC and empties caches, sets the gate, and logs once per crossing", () => {
  const gate = new HeavyGate();
  const lines: string[] = [];
  let gcs = 0;
  let cleared = 0;
  registerCache("test", () => cleared++);
  let now = r(900);
  const w = startMemoryWatchdog({ log: (l) => lines.push(l), read: () => now, gate, gc: () => gcs++, intervalMs: 3_600_000 });
  w.check();
  w.check();
  assert.equal(gcs, 2);
  assert.equal(cleared, 2);
  assert.equal(lines.length, 1, "one line for the crossing, not one per pass");
  assert.equal(gate.status().lowMemory, undefined);
  now = r(950);
  w.check();
  assert.ok(gate.status().lowMemory);
  now = r(100);
  w.check();
  assert.equal(gate.status().lowMemory, undefined);
  assert.ok(lines.some((l) => /allowed again/.test(l)));
  w.stop();
  assert.deepEqual(dropCaches().includes("test"), true);
});
