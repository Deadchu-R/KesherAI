import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSteps, stepsTool } from "./steps-tool.js";

test("set_steps: cleans the list, accepts other spellings of the status, and refuses bad lists", async () => {
  assert.deepEqual(cleanSteps([{ text: "  Read   the code ", status: "completed" }, { text: "Fix", status: "in_progress" }, { text: "Test" }]), [
    { text: "Read the code", status: "done" },
    { text: "Fix", status: "doing" },
    { text: "Test", status: "pending" },
  ]);
  assert.throws(() => cleanSteps([]), /needs/);
  assert.throws(() => cleanSteps([{ text: "", status: "done" }]), /text/);
  assert.throws(() => cleanSteps([{ text: "a", status: "doing" }, { text: "b", status: "doing" }]), /one step/);
  assert.throws(() => cleanSteps(Array.from({ length: 13 }, (_, i) => ({ text: `s${i}`, status: "pending" }))), /12/);
  const r = await stepsTool().run({ steps: [{ text: "a", status: "done" }, { text: "b", status: "doing" }] }, {} as never);
  assert.match(String(r.output), /1\/2 done; now: b/);
});
