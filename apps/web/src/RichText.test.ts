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
