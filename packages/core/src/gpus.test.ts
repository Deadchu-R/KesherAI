import { test } from "node:test";
import assert from "node:assert/strict";
import { planGpus, userChoseGpus, type Gpu } from "./gpus.js";

const GB = 1024 ** 3;
const pair: Gpu[] = [
  { index: 0, name: "NVIDIA GeForce RTX 3090", vramTotal: 24 * GB, vramFree: 23 * GB, computeCap: 8.6 },
  { index: 1, name: "NVIDIA GeForce RTX 5090", vramTotal: 32 * GB, vramFree: 31 * GB, computeCap: 12 },
];

test("a model that fits the fastest card runs there alone", () => {
  const p = planGpus(pair, { mode: "auto" }, 14 * GB);
  assert.deepEqual(p.args, []);
  assert.equal(p.env.CUDA_VISIBLE_DEVICES, "1");
  assert.equal(p.env.CUDA_DEVICE_ORDER, "PCI_BUS_ID");
  assert.match(p.summary, /5090 only/);
});

test("a big model is split by free memory, and the newer card leads", () => {
  const p = planGpus(pair, { mode: "auto" }, 40 * GB);
  assert.deepEqual(p.args, ["--split-mode", "layer", "--tensor-split", "43,57", "--main-gpu", "1"]);
  assert.equal(p.env.CUDA_VISIBLE_DEVICES, "0,1");
  assert.deepEqual(p.cards, [1, 0]);
});

test("the user's shares, leader and card choice win", () => {
  const p = planGpus(pair, { mode: "all", split: [1, 3], main: 0 }, 1 * GB);
  assert.deepEqual(p.args, ["--split-mode", "layer", "--tensor-split", "25,75", "--main-gpu", "0"]);
  assert.equal(planGpus(pair, { mode: "auto", use: [0] }, 40 * GB).env.CUDA_VISIBLE_DEVICES, "0");
  assert.equal(userChoseGpus(["-ngl", "99", "--tensor-split", "1,1"]), true);
  assert.equal(userChoseGpus(["-ngl", "99"]), false);
});
