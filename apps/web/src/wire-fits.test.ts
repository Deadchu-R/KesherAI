import { test } from "node:test";
import assert from "node:assert/strict";
import { wireFits } from "./wire-fits.js";

test("wire fits: same types, numbers convert, exec only to exec, lists only to lists", () => {
  assert.equal(wireFits("bool", "bool").ok, true);
  assert.deepEqual(wireFits("real", "int"), { ok: true, why: "real → int" });
  assert.equal(wireFits("exec", "bool").ok, false);
  assert.equal(wireFits("bool", "real").ok, false);
  assert.equal(wireFits("object:Pawn", "object:Actor").ok, true);
  assert.equal(wireFits("object:Actor", "object:Pawn").ok, false);
  assert.equal(wireFits("real", "wildcard").ok, true);
  assert.equal(wireFits("struct:Vector", "struct:Rotator").ok, false);
  assert.equal(wireFits("int[]", "int").ok, false);
  assert.equal(wireFits("struct:Vector", "struct:Vector").ok, true);
});
