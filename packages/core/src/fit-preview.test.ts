import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFit, parseFitPrint } from "./fit-preview.js";

// What llama-fit-params (b12110) wrote on the RTX 3090 with another model already loaded.
const LOG = `0.00.512.000 I print_info: n_layer               = 64
0.01.561.041 I common_params_fit_impl:   - CUDA0 (NVIDIA GeForce RTX 3090): 60 layers,  16727 MiB used,   1237 MiB free
0.01.561.047 I common_fit_params: successfully fit params to free device memory
0.01.561.053 I common_fit_params: fitting params to free memory took 1.48 seconds`;

test("reads the plan: layers on each card, memory used and left, context, all on the card or not", () => {
  const p = parseFit(LOG, "-c 49152 -ngl 60\n", 1480);
  assert.equal(p.ok, true);
  assert.deepEqual(p.devices, [{ name: "NVIDIA GeForce RTX 3090 (CUDA0)", layers: 60, usedMiB: 16727, freeMiB: 1237 }]);
  assert.equal(p.totalLayers, 65);
  assert.equal(p.gpuLayers, 60);
  assert.equal(p.context, 49152);
  assert.equal(p.inSystemMemory, false);
  const moe = parseFit("successfully fit params", "-ngl 99 -ot blk\\.(2[0-9])\\.ffn_.*_exps=CPU", 900);
  assert.equal(moe.inSystemMemory, true);
  assert.equal(moe.gpuLayers, 99);
  assert.equal(parseFit("failed to fit params", "", 10).ok, false);
});

test("a model the build does not know: no plan, and llama.cpp's reason", () => {
  const p = parseFit("0.00.120.400 E llama_model_load: error loading model: unknown model architecture: 'qwen4next'\n", "", 300);
  assert.equal(p.ok, false);
  assert.equal(p.gpuLayers, 0);
  assert.match(p.error ?? "", /unknown model architecture: 'qwen4next'/);
  assert.ok(!/^0\.00/.test(p.error ?? ""), "no timestamp");
});

test("b12110: a MoE plan with overflowing layers, and no 'successfully' line (it is trace-only now)", () => {
  const log = "0.01.2 T common_params_fit_impl:   - CUDA0 (NVIDIA GeForce RTX 3090): 49 layers (32 overflowing),  21980 MiB used,   2048 MiB free\n";
  const p = parseFit(log, '-c 32768 -ngl 49 -ot "blk\\.7\\.ffn_up_exps=CPU"\n', 3400);
  assert.equal(p.ok, true);
  assert.deepEqual(p.devices, [{ name: "NVIDIA GeForce RTX 3090 (CUDA0)", layers: 49, usedMiB: 21980, freeMiB: 2048 }]);
  assert.equal(p.inSystemMemory, true);
  const no = parseFit("0.01 E llama_fit_params: failed to fit CLI arguments to free memory, exiting...\n", "", 900);
  assert.equal(no.ok, false);
});

test("--fit-print: the system memory the plan needs, from its Host line", () => {
  assert.deepEqual(parseFitPrint("CUDA0 20480 1024 512\nHost 61000 0 900\n"), { hostMiB: 61900 });
  assert.deepEqual(parseFitPrint("nothing here"), {});
});

test("a card written twice (a first pass, then the plan) counts once, with the last line", () => {
  const log = "  - CUDA0 (NVIDIA GeForce RTX 3090): 49 layers (40 overflowing),   5993 MiB used,  11780 MiB free\n  - CUDA0 (NVIDIA GeForce RTX 3090): 49 layers (32 overflowing),  15708 MiB used,   2066 MiB free\n";
  const p = parseFit(log, "-c 32768 -ngl 49\n", 3500);
  assert.equal(p.devices.length, 1);
  assert.equal(p.devices[0]!.usedMiB, 15708);
  assert.equal(p.gpuLayers, 49);
});
