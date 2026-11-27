import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderRegistry } from "@kesher/providers";
import { modelTurnFor, onModelSettings } from "./model-turn.js";

test("a model server that is not running is named as such, not as a too-long conversation", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const registry = {
    resolve: () => ({ provider: { id: "lmstudio", chatWithTools: async () => Promise.reject(refused) }, providerModelId: "qwen" }),
  } as unknown as ProviderRegistry;
  const turn = modelTurnFor(registry, "lmstudio/qwen");
  await assert.rejects(turn({ messages: [{ role: "user", content: "hi" }], tools: [] }, new AbortController().signal, () => undefined), /lmstudio\/qwen is not running/);
});

/** A registry whose llama.cpp provider records the request it gets. */
function llamaRegistry(model: string, seen: Array<{ thinking?: string }>): ProviderRegistry {
  return {
    resolve: () => ({
      provider: { id: "llamacpp", location: "local", chatWithTools: async (r: { thinking?: string }) => (seen.push(r), { text: "ok", toolCalls: [] }) },
      providerModelId: model,
    }),
  } as unknown as ProviderRegistry;
}
const ask = { messages: [{ role: "user" as const, content: "hi" }], tools: [] };

test("helper jobs (no chat thinking level) get thinking off on reasoning models, incl. DictaLM Nemotron and Qwen3.5", async () => {
  for (const model of ["Qwen3.5-2B-Q4_K_M", "DictaLM-3.0-Nemotron-12B-Instruct-Q4_K_M"]) {
    const seen: Array<{ thinking?: string }> = [];
    await modelTurnFor(llamaRegistry(model, seen), `llamacpp/${model}`)(ask, new AbortController().signal, () => undefined);
    assert.equal(seen[0]?.thinking, "off", model);
  }
});

test("the chat's own choice wins: unset leaves the model's default, high is sent", async () => {
  const seen: Array<{ thinking?: string }> = [];
  const reg = llamaRegistry("Qwen3.5-2B-Q4_K_M", seen);
  await modelTurnFor(reg, "llamacpp/x", undefined, "main", { thinking: () => undefined })(ask, new AbortController().signal, () => undefined);
  await modelTurnFor(reg, "llamacpp/x", undefined, "main", { thinking: () => "high" })(ask, new AbortController().signal, () => undefined);
  assert.equal(seen[0]?.thinking, undefined);
  assert.equal(seen[1]?.thinking, "high");
});

test("a model that does not think is sent no thinking flag", async () => {
  const seen: Array<{ thinking?: string }> = [];
  await modelTurnFor(llamaRegistry("Llama-3.1-8B-Instruct", seen), "llamacpp/x")(ask, new AbortController().signal, () => undefined);
  assert.equal(seen[0]?.thinking, undefined);
});

type Sampled = { temperature?: number; topP?: number; topK?: number; minP?: number; presencePenalty?: number };

/** A registry of one provider (llama.cpp or another) that records what the request carries. */
function samplingRegistry(id: string, location: string, model: string, seen: Sampled[]): ProviderRegistry {
  return {
    resolve: () => ({ provider: { id, location, chatWithTools: async (r: Sampled) => (seen.push(Object.fromEntries((Object.entries(r) as Array<[string, number]>).filter(([k]) => ["temperature", "topP", "topK", "minP", "presencePenalty"].includes(k)))), { text: "ok", toolCalls: [] }) }, providerModelId: model }),
  } as unknown as ProviderRegistry;
}
const agentAsk = { messages: [{ role: "user" as const, content: "hi" }], tools: [{ name: "t", description: "d", inputSchema: {} }] };

test("a local Qwen3.6 agent turn carries the vendor's sampling; plain chat with thinking off carries the non-thinking values", async () => {
  onModelSettings(() => undefined);
  const seen: Sampled[] = [];
  const reg = samplingRegistry("llamacpp", "local", "Qwen_Qwen3.6-27B-Q4_K_M", seen);
  await modelTurnFor(reg, "llamacpp/x", undefined, "main", { thinking: () => "high" })(agentAsk, new AbortController().signal, () => undefined);
  await modelTurnFor(reg, "llamacpp/x", undefined, "main", { thinking: () => "off" })(ask, new AbortController().signal, () => undefined);
  assert.deepEqual(seen[0], { temperature: 0.6, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0 });
  assert.deepEqual(seen[1], { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5 });
});

test("the user's own sampling for the model wins over the preset; a persona's temperature wins its field", async () => {
  const seen: Sampled[] = [];
  const reg = samplingRegistry("llamacpp", "local", "Qwen_Qwen3.6-27B-Q4_K_M", seen);
  onModelSettings((file) => (file === "Qwen_Qwen3.6-27B-Q4_K_M.gguf" ? { extra: ["--temp", "0.3"] } : undefined));
  await modelTurnFor(reg, "llamacpp/x")(agentAsk, new AbortController().signal, () => undefined);
  assert.deepEqual(seen[0], {});
  onModelSettings(() => ({ samplingOff: true }));
  await modelTurnFor(reg, "llamacpp/x")(agentAsk, new AbortController().signal, () => undefined);
  assert.deepEqual(seen[1], {});
  onModelSettings(() => undefined);
  await modelTurnFor(reg, "llamacpp/x", { temperature: 0.2 })(agentAsk, new AbortController().signal, () => undefined);
  assert.equal(seen[2]?.temperature, 0.2);
  assert.equal(seen[2]?.topK, 20);
});

test("cloud and other servers get no preset", async () => {
  onModelSettings(() => undefined);
  for (const [id, loc] of [["openrouter", "cloud"], ["lmstudio", "local"]]) {
    const seen: Sampled[] = [];
    await modelTurnFor(samplingRegistry(id!, loc!, "Qwen_Qwen3.6-27B-Q4_K_M", seen), `${id}/x`)(agentAsk, new AbortController().signal, () => undefined);
    assert.deepEqual(seen[0], {}, id);
  }
});
