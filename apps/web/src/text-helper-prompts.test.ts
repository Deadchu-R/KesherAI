import { test } from "node:test";
import assert from "node:assert/strict";
import { actionPrompt, translateTarget } from "./text-helper-prompts.js";

test("translate goes from Hebrew to English, and otherwise to the app's language", () => {
  assert.equal(translateTarget("שלום עולם", "he"), "English");
  assert.equal(translateTarget("שלום עולם", "en"), "English");
  assert.equal(translateTarget("Hello world", "he"), "Hebrew");
  assert.equal(translateTarget("Bonjour", "en"), "English");
});

test("every action quotes the selected text", () => {
  for (const k of ["summarize", "explain", "translate", "fix", "simpler", "reply"] as const) {
    const p = actionPrompt(k, "the text", "en");
    assert.ok(p.endsWith('"""\nthe text\n"""'), k);
  }
});
