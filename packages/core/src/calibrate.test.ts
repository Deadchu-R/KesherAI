import { test } from "node:test";
import assert from "node:assert/strict";
import { advise, parseBench } from "./calibrate.js";

// llama-bench (b12110) on the RTX 3090, Qwen3.8-27B: the -o json shape, trimmed.
const row = (type_k: string, n_depth: number, n_prompt: number, n_gen: number, avg_ts: number) => ({ type_k, n_depth, n_prompt, n_gen, avg_ts, gpu_info: "NVIDIA GeForce RTX 3090" });

test("merges reading and writing per context type and depth", () => {
  const rows = parseBench(`log line\n${JSON.stringify([row("q8_0", 0, 512, 0, 1499.4), row("q8_0", 0, 0, 64, 40.61), row("f16", 16384, 512, 0, 1253), row("f16", 16384, 0, 64, 38.9)])}\n`);
  assert.deepEqual(rows, [{ kv: "q8_0", depth: 0, read: 1499, write: 40.6 }, { kv: "f16", depth: 16384, read: 1253, write: 38.9 }]);
  assert.deepEqual(parseBench("no json"), []);
});

test("keeps 8-bit context unless 16-bit writes clearly faster deep into a chat", () => {
  // Measured on the PC: at 16K, 38.9 (f16) against 36.9 (q8_0): 5% — not worth half the context.
  const measured = advise([{ kv: "f16", depth: 16384, write: 38.9 }, { kv: "q8_0", depth: 16384, write: 36.9 }, { kv: "q8_0", depth: 49152, write: 31 }]);
  assert.equal(measured.kv, "q8_0");
  assert.equal(measured.f16Gain, 5);
  assert.equal(advise([{ kv: "f16", depth: 16384, write: 44 }, { kv: "q8_0", depth: 16384, write: 36 }]).kv, "f16");
  assert.equal(advise([]).kv, "q8_0");
});
