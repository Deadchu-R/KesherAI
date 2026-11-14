import { test } from "node:test";
import assert from "node:assert/strict";
import { failureKey } from "./session.js";

test("the loop guard's key: the same failure matches, a success or another failure does not", () => {
  const a = failureKey("run_command", "Building…\nerror CS1002: ; expected at Player.cs(12,5)\nexit code 1");
  const b = failureKey("run_command", "Building…\nerror CS1002: ; expected at Player.cs(14,9)\nexit code 1");
  const c = failureKey("run_command", "error CS0103: The name 'x' does not exist");
  assert.ok(a);
  assert.equal(a, b, "the same error at another line is the same failure");
  assert.notEqual(a, c);
  assert.equal(failureKey("read_file", "using UnityEngine;\npublic class P {}"), undefined);
  assert.equal(failureKey("read_file", "Error: no such file 'a.cs'"), failureKey("read_file", "Error: no such file 'b.cs'"));
});
