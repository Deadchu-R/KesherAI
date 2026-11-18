import { test } from "node:test";
import assert from "node:assert/strict";
import { paramsOf, scoreModel, suggestModel, toolNeed, type SpeedEstimate } from "./model-fit.js";

// A 24 GB card: about 900 GB/s; what does not fit spills into memory and slows down; over 40 GB does not fit.
const pc: SpeedEstimate = (sizeGb, active = 1) => {
  if (sizeGb > 40) return { tokensPerSecond: 0, fitsGpu: false };
  const fitsGpu = sizeGb * 1.1 <= 20.6;
  return { tokensPerSecond: Math.round(((fitsGpu ? 540 : 60) / (sizeGb * active)) * 10) / 10, fitsGpu };
};
const gemma = { name: "gemma-4-31B-it-Q4_K_M.gguf", path: "/m/gemma.gguf", size: 18e9 };
const dicta = { name: "dictalm-3.0-12b-Q4_K_M.gguf", path: "/m/dicta.gguf", size: 7.4e9 };

test("parameters from the name or the size", () => {
  assert.equal(paramsOf("gemma-4-31B-it-Q4_K_M", 18), 31);
  assert.equal(paramsOf("Qwen3-Coder-30B-A3B-Instruct", 18), 30);
  assert.equal(paramsOf("Mixtral-8x7B", 26), 56);
  assert.equal(paramsOf("mystery", 6), 10);
  assert.equal(paramsOf("Llama-3-8B-Instruct", 4.8), 8);
  assert.equal(paramsOf("mistral-7b-v0.3", 4.2), 7);
  assert.equal(paramsOf("phi-3-mini-3.8b-instruct", 2.3), 3.8);
  assert.equal(paramsOf("deepseek-coder-6.7b-base", 3.9), 6.7);
  assert.equal(paramsOf("yi-9b-chat", 5.4), 9);
});

test("a mixture of experts is scored by its active part's speed", () => {
  const moe = scoreModel("Qwen3-Coder-30B-A3B-Instruct-Q4_K_M", 18.6, toolNeed("code", false), pc);
  const dense = scoreModel("Qwen3-Coder-30B-Instruct-Q4_K_M", 18.6, toolNeed("code", false), pc);
  assert.ok(moe.tokensPerSecond > dense.tokensPerSecond * 5);
});

test("a score adds quality, fit for the tool and speed here; too big scores 0", () => {
  const s = scoreModel(dicta.name, 7.4, toolNeed("chat-report", true), pc);
  assert.deepEqual([s.quality, s.fit, s.fitsGpu], [22, 35, true]);
  assert.ok(s.total > scoreModel(gemma.name, 18, toolNeed("chat-report", true), pc).total);
  assert.equal(scoreModel("llama-70b", 42, toolNeed("code", false), pc).total, 0);
});

test("Hebrew chat reports: the DictaLM on the computer beats the loaded Gemma", () => {
  const s = suggestModel(toolNeed("chat-report", true), { name: gemma.name, slotTokens: 131072 }, [gemma, dicta], pc);
  assert.equal(s?.options[0]?.kind, "switch");
  assert.equal(s?.options[0]?.kind === "switch" && s.options[0].path, "/m/dicta.gguf");
  assert.ok(s!.options[0]!.score.total >= s!.loaded!.score.total + 8);
});

test("Study uses the DictaLM by itself: no line; without one, a download", () => {
  assert.equal(suggestModel(toolNeed("study", true), { name: gemma.name }, [gemma, dicta], pc), undefined);
  const s = suggestModel(toolNeed("study", true), { name: gemma.name }, [gemma], pc);
  assert.deepEqual(s?.options.map((o) => [o.kind, o.kind === "download" && o.id]), [["download", "dictalm-12b"]]);
});

test("the code agent: a coding model beats Gemma; a small loaded model gets the installed coding model", () => {
  assert.deepEqual(suggestModel(toolNeed("code", true), { name: gemma.name, slotTokens: 65536 }, [gemma], pc)?.options.map((o) => o.name), ["Qwen3 Coder 30B"]);
  const small = { name: "Qwen3-4B-Q4_K_M.gguf", path: "/m/q4.gguf", size: 2.5e9 };
  const oss = { name: "gpt-oss-20b-mxfp4.gguf", path: "/m/oss.gguf", size: 12e9 };
  const s = suggestModel(toolNeed("code", true), { name: small.name, slotTokens: 65536 }, [small, oss], pc);
  assert.deepEqual(s?.options.map((o) => [o.kind, o.name]), [["switch", "gpt-oss-20b"]]);
});

test("a small computer: only what fits is offered", () => {
  const laptop: SpeedEstimate = (sizeGb) => (sizeGb > 9 ? { tokensPerSecond: 0, fitsGpu: false } : { tokensPerSecond: Math.round(120 / sizeGb), fitsGpu: sizeGb < 5 });
  const s = suggestModel(toolNeed("code", true), { name: "Qwen3-4B-Q4_K_M.gguf", size: 2.5e9 }, [], laptop);
  for (const o of s?.options ?? []) assert.ok(o.sizeGb <= 9);
});

test("long chat reports ask for a longer context", () => {
  assert.deepEqual(suggestModel(toolNeed("chat-report", true), { name: dicta.name, slotTokens: 32768 }, [dicta], pc)?.context, { have: 32768, want: 65536 });
});
