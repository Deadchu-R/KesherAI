import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFit } from "./fit-preview.js";

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
