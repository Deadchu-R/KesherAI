import { test } from "node:test";
import assert from "node:assert/strict";
import { isTableRule } from "./RichText.js";

test("the line under a table's header is recognised (and other lines are not)", () => {
  assert.ok(isTableRule("|-------|---------------------------|--------------------------|-------|"));
  assert.ok(isTableRule("| :--- | :---: | ---: |"));
  assert.ok(isTableRule("---|---"));
  assert.ok(!isTableRule("---"), "a horizontal rule is not a table");
  assert.ok(!isTableRule("| a | b |"));
});

test("simple TeX reads as text", async () => {
  const { texText } = await import("./RichText.js");
  assert.equal(texText("v = \\Delta x / \\Delta t"), "v = Δx / Δt");
  assert.equal(texText("E = mc^2"), "E = mc²");
  assert.equal(texText("\\frac{a}{b} + x_1"), "(a)/(b) + x₁");
  assert.equal(texText("\\unknown{x}"), "\\unknown{x}");
});
