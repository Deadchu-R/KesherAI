import { test } from "node:test";
import assert from "node:assert/strict";
import { hasRouterMode, plainCcdRange, presetIni, roleArgs } from "./build-cpu-pool.js";

test("router mode only on builds that have it", () => {
  assert.equal(hasRouterMode("b12110"), true);
  assert.equal(hasRouterMode("b6500"), false);
  assert.equal(hasRouterMode(undefined), false);
});

test("the plain CCD of a two-CCD X3D is the upper half; one-CCD and other chips are not pinned", () => {
  assert.equal(plainCcdRange("AMD Ryzen 9 9950X3D 16-Core Processor", 16, 32), "16-31");
  assert.equal(plainCcdRange("AMD Ryzen 7 9800X3D 8-Core Processor", 8, 16), undefined);
  assert.equal(plainCcdRange("Intel(R) Core(TM) i9-14900K", 24, 32), undefined);
});

test("every role runs on the CPU at low priority; embeddings get their batch flags", () => {
  const args = roleArgs("embeddings", { file: "/m/e.gguf", ramMb: 700, embeddings: true }, 7, "16-31");
  assert.deepEqual(args.slice(0, 4), [["n-gpu-layers", "0"], ["threads", "7"], ["ctx-size", "8192"], ["prio", "-1"]]);
  assert.ok(args.some(([k]) => k === "embeddings"));
  assert.ok(args.some(([k, v]) => k === "cpu-range" && v === "16-31"));
});

test("the router's preset has one section per role, named after it", () => {
  const ini = presetIni([
    { role: "watchdog", spec: { file: "/m/Qwen3.5-2B-Q4_K_M.gguf", ramMb: 1500 }, threads: 7 },
    { role: "translator", spec: { file: "/m/translategemma-4b.gguf", ramMb: 3000 }, threads: 7 },
  ]);
  assert.match(ini, /\[watchdog\]\nmodel = \/m\/Qwen3\.5-2B-Q4_K_M\.gguf\nn-gpu-layers = 0\nthreads = 7/);
  assert.match(ini, /\[translator\]/);
  assert.doesNotMatch(ini, /embeddings = true/);
});
