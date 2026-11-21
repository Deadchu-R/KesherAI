import { test } from "node:test";
import assert from "node:assert/strict";
import { dismissPc, newerVersion, reviewPcs } from "../page/pc-updated.js";

const pc = (id: string, version?: string, kind = "pc") => ({ id, name: `PC ${id}`, kind, ...(version ? { version } : {}) });

test("versions compare by number", () => {
  assert.ok(newerVersion("0.6.10", "0.6.9"));
  assert.ok(!newerVersion("0.6.9", "0.6.9"));
});

test("a PC seen for the first time is only remembered, no card", () => {
  const r = reviewPcs([pc("a", "0.6.5")], {});
  assert.deepEqual(r.updated, []);
  assert.deepEqual(r.seen, { a: "0.6.5" });
});

test("an updated PC makes a card until it is dismissed; phones and unknown versions never do", () => {
  const r = reviewPcs([pc("a", "0.6.6"), pc("b"), pc("c", "0.7.0", "phone")], { a: "0.6.5" });
  assert.deepEqual(r.updated.map((u) => [u.id, u.from, u.version]), [["a", "0.6.5", "0.6.6"]]);
  assert.equal(r.seen.a, "0.6.5");
  const after = reviewPcs([pc("a", "0.6.6")], dismissPc(r.seen, r.updated[0]!));
  assert.deepEqual(after.updated, []);
});
