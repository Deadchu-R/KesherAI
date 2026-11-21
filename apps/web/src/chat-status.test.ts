import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPACT_AT, chatStatus, contextShare, kTokens } from "./chat-status.js";

test("/status adds the tokens and takes the context from the last main call", () => {
  const s = chatStatus([
    { type: "user" },
    { type: "usage", role: "main", input: 1200, output: 300 },
    { type: "usage", role: "reviewer", input: 5000, output: 80 },
    { type: "usage", role: "main", input: 2400, output: 150 },
  ]);
  assert.deepEqual(s, { context: 2400, input: 8600, output: 530, calls: 3 });
  assert.equal(kTokens(950), "950");
  assert.equal(kTokens(12_345), "12.3K");
  assert.equal(kTokens(250_000), "250K");
});

test("contextShare: the ring's fill, capped at full, unknown before the first call", () => {
  assert.equal(contextShare(8192, 32768), 0.25);
  assert.equal(contextShare(40000, 32768), 1);
  assert.equal(contextShare(0, 32768), undefined);
  assert.equal(contextShare(1000, undefined), undefined);
  assert.ok(contextShare(27000, 32768)! >= COMPACT_AT, "compact is offered from 80%");
});
