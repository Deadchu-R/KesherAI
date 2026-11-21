import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { damagedRanges, hashesMatch, planRepair, scanFile } from "./verify.js";

test("hashesMatch ignores case and spaces and needs a real 64-digit hash", () => {
  const h = createHash("sha256").update("x").digest("hex");
  assert.ok(hashesMatch(h, ` ${h.toUpperCase()} `));
  assert.ok(!hashesMatch(h, h.replace(/^./, "0")));
  assert.ok(!hashesMatch("abc", "abc"), "a short value is not a hash");
  assert.ok(!hashesMatch(h, ""));
});

test("scanFile gives the SHA-256 and the all-zero blocks, also across chunks and in a short last block", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-vf-"));
  const file = join(dir, "f.bin");
  // Blocks of 1000 bytes: data, hole, data, hole (a short last block of 300 zero bytes).
  const buf = Buffer.concat([Buffer.alloc(1000, 5), Buffer.alloc(1000), Buffer.alloc(1000, 6), Buffer.alloc(300)]);
  await writeFile(file, buf);
  const seen: number[] = [];
  const scan = await scanFile(file, { blockSize: 1000, onProgress: (n) => seen.push(n) });
  assert.equal(scan.sha256, createHash("sha256").update(buf).digest("hex"));
  assert.deepEqual(scan.zeroBlocks, [1, 3]);
  assert.equal(seen[seen.length - 1], buf.length);
});

test("damagedRanges joins neighbouring blocks, stops at the file's end and is cut at part edges", () => {
  assert.deepEqual(damagedRanges([2, 3, 4, 8], 9500, 1000), [{ start: 2000, end: 4999 }, { start: 8000, end: 8999 }]);
  assert.deepEqual(damagedRanges([9], 9500, 1000), [{ start: 9000, end: 9499 }]);
  assert.deepEqual(damagedRanges([], 9500, 1000), []);
  const parts = [{ start: 0, end: 3999 }, { start: 4000, end: 9499 }];
  assert.deepEqual(damagedRanges([3, 4], 9500, 1000, parts), [{ start: 3000, end: 3999 }, { start: 4000, end: 4999 }]);
});

test("planRepair: ranges only with a known layout and a few holes, otherwise the whole file", () => {
  const parts = [{ start: 0, end: 4999 }, { start: 5000, end: 9999 }];
  const plan = planRepair([6], 10_000, parts, 1000);
  assert.deepEqual(plan, { kind: "ranges", ranges: [{ start: 6000, end: 6999 }], bytes: 1000 });
  assert.deepEqual(planRepair([6], 10_000, undefined, 1000), { kind: "whole" }, "one stream: no layout");
  assert.deepEqual(planRepair([], 10_000, parts, 1000), { kind: "whole" }, "no holes found: damage of another kind");
  assert.deepEqual(planRepair([0, 1, 2, 3, 4, 5], 10_000, parts, 1000), { kind: "whole" }, "most of the file: cheaper whole");
});
