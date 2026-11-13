import { test } from "node:test";
import assert from "node:assert/strict";
import { numberedDiff, parseReview } from "./code-review.js";

test("the diff names each line by its number in the new file", () => {
  const d = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -10,3 +10,3 @@", " keep", "-old", "+new", " end"].join("\n");
  const out = numberedDiff(d).split("\n");
  assert.equal(out[4], "L10    keep");
  assert.equal(out[5], "      -old");
  assert.equal(out[6], "L11   +new");
  assert.equal(out[7], "L12    end");
});

test("review answers: JSON in words or a fence; unknown files and empty notes dropped", () => {
  const text = 'Here:\n```json\n[{"file":"b/x.ts","line":"11","severity":"bug","note":"x can be null"},{"file":"y.ts","line":1,"note":"not changed"},{"file":"x.ts","line":2,"note":""}]\n```';
  assert.deepEqual(parseReview(text, ["x.ts"]), [{ file: "x.ts", line: 11, severity: "bug", note: "x can be null" }]);
  assert.deepEqual(parseReview("Looks fine.", ["x.ts"]), []);
});
