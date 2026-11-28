import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackModelList } from "./self-work-fallback.js";
import type { CandidateModel } from "./code-model.js";

const m = (id: string, location: CandidateModel["location"], category = "chat"): CandidateModel => ({ id, name: id, category, location });

test("fallback list: the loaded local model first, other local ones by coding strength, then free providers only", () => {
  const models = [
    m("openrouter/some-paid-model", "cloud"),
    m("lmstudio/qwen3-8b", "local"),
    m("llamacpp/loaded-one", "local"),
    m("lmstudio/qwen3-coder-30b-a3b", "local"),
    m("zai/glm-4.7-flash", "cloud"),
    m("lmstudio/some-embedder", "local", "embedding"),
  ];
  const list = fallbackModelList(models, "llamacpp/loaded-one");
  assert.equal(list[0], "llamacpp/loaded-one");
  assert.ok(list.indexOf("lmstudio/qwen3-coder-30b-a3b") < list.indexOf("lmstudio/qwen3-8b"));
  assert.ok(!list.includes("openrouter/some-paid-model"), "a model that is not a free one is never a fallback");
  assert.ok(!list.includes("lmstudio/some-embedder"));
  assert.equal(new Set(list).size, list.length);
  assert.deepEqual(fallbackModelList([], "x"), []);
});
