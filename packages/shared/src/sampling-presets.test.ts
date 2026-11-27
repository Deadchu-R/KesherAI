import { test } from "node:test";
import assert from "node:assert/strict";
import { samplingFamily, samplingFor, samplingPreset, samplingSummary, userSamplingWins } from "./sampling-presets.js";

test("the family comes from real file names", () => {
  assert.equal(samplingFamily("Qwen_Qwen3.6-27B-Q4_K_M.gguf"), "qwen");
  assert.equal(samplingFamily("gemma-4-26b-a4b-it-Q4_K_M.gguf"), "gemma");
  assert.equal(samplingFamily("llamacpp/GLM-4.7-Flash-Q4_K_M"), "glm");
  assert.equal(samplingFamily("DeepSeek-R1-0528-Q4_K_M.gguf"), "deepseek");
  assert.equal(samplingFamily("Llama-3.3-70B-Instruct-Q4_K_M.gguf"), "llama");
  assert.equal(samplingFamily("Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf"), "mistral");
  assert.equal(samplingFamily("phi-4-Q4_K_M.gguf"), "phi");
  assert.equal(samplingFamily("DictaLM-3.0-Nemotron-12B-Instruct-Q4_K_M.gguf"), "other");
});

test("Qwen3.6: agent turns use the precise-coding values, plain chat follows the thinking mode", () => {
  const f = "Qwen_Qwen3.6-27B-Q4_K_M.gguf";
  assert.deepEqual(samplingPreset(f, { agent: true, thinking: true })?.values, { temperature: 0.6, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0 });
  assert.deepEqual(samplingPreset(f, { agent: false, thinking: true })?.values, { temperature: 1.0, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0 });
  assert.deepEqual(samplingPreset(f, { agent: false, thinking: false })?.values, { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5 });
  assert.equal(samplingPreset(f, { agent: true, thinking: false })?.values.presencePenalty, 0);
  assert.equal(samplingPreset("Qwen3.5-27B-Q4_K_M.gguf", { agent: false, thinking: true })?.values.presencePenalty, 1.5);
});

test("other families: Gemma 4, GLM-4.7, DeepSeek, Mistral Small 3.2; no official value means no preset", () => {
  const chat = { agent: false, thinking: true };
  assert.deepEqual(samplingPreset("gemma-4-26b-a4b-it-Q4_K_M.gguf", chat)?.values, { temperature: 1.0, topP: 0.95, topK: 64 });
  assert.deepEqual(samplingPreset("GLM-4.7-Flash-Q4_K_M.gguf", { agent: true, thinking: true })?.values, { temperature: 0.7, topP: 1.0 });
  assert.deepEqual(samplingPreset("DeepSeek-R1-0528-Q4_K_M.gguf", chat)?.values, { temperature: 0.6, topP: 0.95 });
  assert.deepEqual(samplingPreset("DeepSeek-V3.2-Q4_K_M.gguf", chat)?.values, { temperature: 1.0, topP: 0.95 });
  assert.deepEqual(samplingPreset("Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf", chat)?.values, { temperature: 0.15 });
  for (const f of ["Llama-3.3-70B-Instruct-Q4_K_M.gguf", "phi-4-Q4_K_M.gguf", "Qwen3-32B-Q4_K_M.gguf", "gemma-3-27b-it-Q4_K_M.gguf", "unknown.gguf"]) {
    assert.equal(samplingPreset(f, chat), undefined, f);
  }
});

test("the user's own settings win: sampling flags, the engine's flags, the defaults switch; a persona wins its field", () => {
  const f = "Qwen_Qwen3.6-27B-Q4_K_M.gguf";
  const agent = { agent: true, thinking: true };
  assert.equal(samplingFor(f, agent, undefined).temperature, 0.6);
  assert.deepEqual(samplingFor(f, agent, { extra: ["--temp", "0.3"] }), {});
  assert.deepEqual(samplingFor(f, agent, { extra: ["--top-k", "10"] }), {});
  assert.deepEqual(samplingFor(f, agent, { samplingOff: true }), {});
  assert.equal(userSamplingWins({ extra: ["--no-mmap"] }), false);
  assert.equal(samplingFor(f, agent, { ctx: 8192 }, { temperature: 0.2 }).temperature, 0.2);
  assert.equal(samplingFor(f, agent, { ctx: 8192 }, { temperature: 0.2 }).topK, 20);
});

test("the settings line: preset, own settings, defaults chosen, no official value", () => {
  const f = "Qwen_Qwen3.6-27B-Q4_K_M.gguf";
  const s = samplingSummary(f, undefined);
  assert.equal(s.state, "preset");
  assert.equal(s.label, "Qwen 3.6");
  assert.equal(s.agent?.temperature, 0.6);
  assert.equal(samplingSummary(f, { extra: ["--temp", "1"] }).state, "custom");
  assert.deepEqual([samplingSummary(f, { samplingOff: true }).state, samplingSummary(f, { samplingOff: true }).label], ["off", "Qwen 3.6"]);
  assert.deepEqual(samplingSummary("Llama-3.3-70B-Instruct.gguf", undefined), { state: "none" });
});
