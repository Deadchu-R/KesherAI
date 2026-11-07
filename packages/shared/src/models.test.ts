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

test("pickSetup chooses by resource level", async () => {
  const { pickSetup } = await import("./recommended.js");
  const list = [
    { id: "4b", goodForCode: false, rating: "good" as const },
    { id: "8b", goodForCode: true, rating: "good" as const },
    { id: "14b", goodForCode: true, rating: "good" as const },
    { id: "20b", goodForCode: true, rating: "slow" as const },
    { id: "30b", goodForCode: true, rating: "too-big" as const },
  ];
  assert.deepEqual(pickSetup(list, "balanced"), { chat: "14b" });
  assert.deepEqual(pickSetup(list, "conservative"), { chat: "8b" });
  assert.deepEqual(pickSetup(list, "extreme"), { chat: "20b" });
  const small = list.map((m) => ({ ...m, rating: m.id === "4b" ? ("good" as const) : ("too-big" as const) }));
  assert.deepEqual(pickSetup(small, "balanced"), { chat: "4b" }, "no coder that fits, so none suggested");
  const weak = [{ ...list[0]! }, { ...list[1]!, rating: "ok" as const }];
  assert.deepEqual(pickSetup(weak, "balanced"), { chat: "4b", code: "8b" });
});
