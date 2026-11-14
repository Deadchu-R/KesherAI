import { test } from "node:test";
import assert from "node:assert/strict";
import { fit } from "./palette-fit.js";

test("palette: starts beat words, words beat anywhere, letters in order still match", () => {
  assert.ok(fit("lib", "Library store") > fit("lib", "Text libraries"));
  assert.ok(fit("store", "Library store") > fit("tor", "Library store"));
  assert.ok(fit("lbst", "Library store") > 0);
  assert.equal(fit("xyz", "Library store"), 0);
  assert.equal(fit("", "anything"), 1);
  assert.ok(fit("ספר", "חנות ספריות") > 0);
});
