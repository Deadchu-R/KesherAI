import { test } from "node:test";
import assert from "node:assert/strict";
import { BENCH_SET, benchRight } from "./bench-set.js";

test("bench answers: right ones pass with extra words, thinking is ignored, wrong ones fail", () => {
  assert.equal(BENCH_SET.length, 10);
  const q = (i: number) => BENCH_SET[i]!;
  assert.ok(benchRight("391.", q(0)));
  assert.ok(benchRight("<think>17*20=340, +51</think>The answer is 391", q(0)));
  assert.ok(!benchRight("<think>maybe 391</think>381", q(0)), "the thinking does not count");
  assert.ok(benchRight("Canberra", q(1)));
  assert.ok(!benchRight("Sydney", q(1)));
  assert.ok(benchRight("פריז", q(9)));
  assert.ok(benchRight("It arrives at 16:15.", q(6)));
});
