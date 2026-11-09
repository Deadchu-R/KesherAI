import { test } from "node:test";
import assert from "node:assert/strict";
import { LspFramer, frame } from "./lsp.js";

test("LSP framing: messages split across chunks, several in one chunk, non-ASCII lengths in bytes", () => {
  const got: string[] = [];
  const f = new LspFramer((j) => got.push(j));
  const a = frame(JSON.stringify({ id: 1, result: "שלום" }));
  const b = frame(JSON.stringify({ method: "x" }));
  const all = Buffer.from(a + b, "utf8");
  f.push(all.subarray(0, 10));
  f.push(all.subarray(10, 40));
  f.push(all.subarray(40));
  assert.deepEqual(got.map((g) => JSON.parse(g)), [{ id: 1, result: "שלום" }, { method: "x" }]);
});
