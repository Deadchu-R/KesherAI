import { test } from "node:test";
import assert from "node:assert/strict";
import { comfyFrame, comfyMessage, runningIn } from "./comfy-progress.js";

test("ComfyUI socket messages become progress for our prompt only", () => {
  assert.deepEqual(comfyMessage(JSON.stringify({ type: "progress", data: { value: 3, max: 20, prompt_id: "p1" } }), "p1"), { phase: "sampling", step: 3, steps: 20 });
  assert.equal(comfyMessage(JSON.stringify({ type: "progress", data: { value: 3, max: 20, prompt_id: "other" } }), "p1"), undefined);
  assert.equal(comfyMessage(JSON.stringify({ type: "executing", data: { node: null, prompt_id: "p1" } }), "p1"), "done");
  assert.deepEqual(comfyMessage(JSON.stringify({ type: "execution_start", data: { prompt_id: "p1" } }), "p1"), { phase: "loading" });
  assert.deepEqual(comfyMessage(JSON.stringify({ type: "status", data: { status: { exec_info: { queue_remaining: 3 } } } }), undefined), { phase: "queued" });
  assert.equal(comfyMessage("not json", "p1"), undefined);
  assert.equal(comfyMessage(JSON.stringify({ type: "progress", data: { value: 1, max: 0 } }), "p1"), undefined);
});

test("a binary preview frame becomes a data URL; other and oversized messages do not", () => {
  const frame = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 0xff, 0xd8, 0xff]);
  assert.equal(comfyFrame(frame.buffer), `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString("base64")}`);
  const png = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 2, 1, 2]);
  assert.match(comfyFrame(png.buffer)!, /^data:image\/png;base64,/);
  assert.equal(comfyFrame(new Uint8Array([0, 0, 0, 2, 0, 0, 0, 1, 1]).buffer), undefined);
  assert.equal(comfyFrame(new Uint8Array(300_000).fill(0).buffer), undefined);
});

test("Cancel interrupts only when our prompt is the one running", () => {
  assert.equal(runningIn({ queue_running: [[5, "p1", {}]] }, "p1"), true);
  assert.equal(runningIn({ queue_running: [[5, "someone", {}]] }, "p1"), false);
  assert.equal(runningIn({}, "p1"), false);
});
