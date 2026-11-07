import { test } from "node:test";
import assert from "node:assert/strict";
import { makeModelId, parseModelId } from "./models.js";
import { categoryForPipelineTag } from "./categories.js";

test("model ids round-trip, keeping slashes in the provider model id", () => {
  const id = makeModelId("hf", "Qwen/Qwen3-14B-GGUF");
  assert.equal(id, "hf/Qwen/Qwen3-14B-GGUF");
  assert.deepEqual(parseModelId(id), { providerId: "hf", providerModelId: "Qwen/Qwen3-14B-GGUF" });
});

test("parseModelId rejects ids without a provider", () => {
  assert.throws(() => parseModelId("no-slash"));
  assert.throws(() => parseModelId("/leading"));
});

test("pipeline tags map to categories", () => {
  assert.equal(categoryForPipelineTag("text-to-image"), "image");
  assert.equal(categoryForPipelineTag("automatic-speech-recognition"), "speech-to-text");
  assert.equal(categoryForPipelineTag("unknown-tag"), undefined);
});
