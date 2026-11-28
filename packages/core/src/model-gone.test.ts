import test from "node:test";
import assert from "node:assert/strict";
import { clearModelGone, GONE_TTL_MS, isMarkedGone, isModelGone, markModelGone } from "./model-gone.js";
import { pickAlternative, type AutoModelRow } from "./auto-model.js";

const row = (id: string, strengths: AutoModelRow["strengths"], loaded = true): AutoModelRow => ({ id, name: id, where: id.startsWith("gemini") ? "cloud" : "local", strengths, custom: false, loaded });

test("the retired-model errors are recognised, busy servers are not", () => {
  assert.ok(isModelGone("This model models/gemini-2.5-flash is no longer available to new users"));
  assert.ok(isModelGone("404 models/gemini-x is not found for API version v1beta"));
  assert.ok(!isModelGone("429 quota exceeded"));
  assert.ok(!isModelGone("The model server is not running"));
});

test("a gone model stays marked for the TTL only", () => {
  clearModelGone();
  markModelGone("gemini/a", 1000);
  assert.ok(isMarkedGone("gemini/a", 1000 + GONE_TTL_MS - 1));
  assert.ok(!isMarkedGone("gemini/a", 1000 + GONE_TTL_MS + 1));
});

test("the alternative shares the most strengths, ready first", () => {
  const rows = [row("llamacpp/qwen", ["tools", "code"]), row("gemini/pro", ["research", "vision", "code"]), row("llamacpp/small", ["fast"], false)];
  assert.equal(pickAlternative(rows, "gemini/flash", ["research", "vision", "fast"]), "gemini/pro");
  assert.equal(pickAlternative([], "x", []), undefined);
});
