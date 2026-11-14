import { test } from "node:test";
import assert from "node:assert/strict";
import { hearFrame, type SilenceState } from "./dictate-silence.js";

const run = (peaks: number[], frameMs = 256) => {
  let s: SilenceState = { spoke: 0, quietMs: 0 };
  for (let i = 0; i < peaks.length; i++) {
    const r = hearFrame(s, peaks[i]!, frameMs);
    s = r.state;
    if (r.stop) return i;
  }
  return -1;
};

test("stops after speech and a two-second pause", () => {
  const i = run([0.2, 0.3, 0.25, ...Array(10).fill(0.005)]);
  assert.equal(i, 3 + 7, "eight quiet frames of 256 ms = 2,048 ms");
});

test("keeps listening before anyone speaks, and after a single click", () => {
  assert.equal(run(Array(40).fill(0.005)), -1);
  assert.equal(run([0.3, ...Array(20).fill(0.005)]), -1);
});

test("a short breath between words does not stop it", () => {
  assert.equal(run([0.2, 0.2, 0.005, 0.005, 0.005, 0.2, 0.2, 0.005, 0.005]), -1);
});
