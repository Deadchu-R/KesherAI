import { test } from "node:test";
import assert from "node:assert/strict";
import { dHashOf, hamming } from "./image-hash";

test("the same picture brighter hashes the same; a different one does not", () => {
  const a = Array.from({ length: 72 }, (_, i) => (i * 37) % 255);
  const brighter = a.map((v) => v * 0.8 + 20);
  const other = Array.from({ length: 72 }, (_, i) => (i * 91 + 13) % 255);
  assert.equal(hamming(dHashOf(a), dHashOf(brighter)), 0);
  assert.ok(hamming(dHashOf(a), dHashOf(other)) > 10);
  assert.equal(hamming(0n, 0xffn), 8);
});
