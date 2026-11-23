import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderRegistry } from "@kesher/providers";
import { modelTurnFor } from "./model-turn.js";

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
