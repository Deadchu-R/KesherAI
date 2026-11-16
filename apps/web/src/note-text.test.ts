import assert from "node:assert/strict";
import { test } from "node:test";
import { noteTitle } from "./note-text.js";

test("known titles are shown in Hebrew, names kept; the rest stay as written", () => {
  assert.equal(noteTitle("✋ Self-work needs you", "he"), "✋ העבודה העצמית צריכה אותך");
  assert.equal(noteTitle("Done: Fix the build", "he"), "הסתיים: Fix the build");
  assert.equal(noteTitle("Downloaded: model.gguf", "he"), "הורד: model.gguf");
  assert.equal(noteTitle("✓ My routine", "he"), "✓ My routine");
  assert.equal(noteTitle("Done: x", "en"), "Done: x");
});
