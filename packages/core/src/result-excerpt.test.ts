import { test } from "node:test";
import assert from "node:assert/strict";
import { resultExcerpt, SCHEDULED_EXCERPT_CHARS } from "./result-excerpt.js";

test("the excerpt is about 120 characters, cut at a word with an ellipsis", () => {
  const long = "word ".repeat(100);
  const x = resultExcerpt(long);
  assert.ok(x.length <= SCHEDULED_EXCERPT_CHARS, String(x.length));
  assert.ok(x.endsWith("…"));
  assert.equal(resultExcerpt("Build passed: 12 tests."), "Build passed: 12 tests.");
  assert.equal(resultExcerpt(undefined), "");
  assert.equal(resultExcerpt("x".repeat(500), 50).length, 50);
});

test("the excerpt hides keys, tokens, passwords and file paths, and flattens markdown", () => {
  const x = resultExcerpt("**Done.** Used key sk-abcdef1234567890 and password=hunter2hunter in C:\\Users\\roee\\game\\a.txt and /home/roee/x/y.ts\n\n```\nsecret code\n```\nAll good");
  assert.doesNotMatch(x, /sk-abcdef|hunter2|roee|a\.txt|secret code|\*\*/);
  assert.match(x, /Done\./);
  assert.match(x, /All good/);
  assert.match(resultExcerpt("see ~/notes/todo.md now"), /see … now/);
  // Hebrew stays whole
  assert.equal(resultExcerpt("הבנייה עברה בהצלחה"), "הבנייה עברה בהצלחה");
});
