import { test } from "node:test";
import assert from "node:assert/strict";
import { isReasoningModel, thinkingFields, thinkingLevels } from "./thinking.js";

test("isReasoningModel knows thinking families and leaves coder and instruct builds out", () => {
  for (const n of ["llamacpp/Qwen3.8-27B-Q4.gguf", "qwen3-8b", "gpt-oss-20b", "DeepSeek-R1-Distill-Qwen-7B", "QwQ-32B", "GLM-4.6-Air", "Magistral-Small"]) assert.ok(isReasoningModel(n), n);
  for (const n of ["qwen3-coder-30b", "Qwen3-30B-A3B-Instruct-2507", "llama-3.1-8b", "gemma-3-12b"]) assert.ok(!isReasoningModel(n), n);
});

test("thinkingLevels: all three on llama.cpp, low/high on other local servers, none in the cloud", () => {
  assert.deepEqual(thinkingLevels("llamacpp", "qwen3-8b"), ["off", "low", "high"]);
  assert.deepEqual(thinkingLevels("lmstudio", "gpt-oss-20b", "server"), ["low", "high"]);
  assert.deepEqual(thinkingLevels("openai", "gpt-oss-120b", "cloud"), []);
  assert.deepEqual(thinkingLevels("llamacpp", "gemma-3-12b"), []);
});

test("thinkingFields maps a level to chat template flags or reasoning_effort", () => {
  assert.deepEqual(thinkingFields(undefined, true), {});
  assert.deepEqual(thinkingFields("off", true), { chat_template_kwargs: { enable_thinking: false, reasoning_effort: "low" } });
  assert.deepEqual(thinkingFields("high", true), { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "high" } });
  assert.deepEqual(thinkingFields("low", false), { reasoning_effort: "low" });
  assert.deepEqual(thinkingFields("off", false), {});
});
