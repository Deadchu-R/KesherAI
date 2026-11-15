import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderRegistry } from "@kesher/providers";
import { modelTurnFor } from "./model-turn.js";

test("a model server that is not running is named as such, not as a too-long conversation", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const registry = {
    resolve: () => ({ provider: { chatWithTools: async () => Promise.reject(refused) }, providerModelId: "qwen" }),
  } as unknown as ProviderRegistry;
  const turn = modelTurnFor(registry, "lmstudio/qwen");
  await assert.rejects(turn({ messages: [{ role: "user", content: "hi" }], tools: [] }, new AbortController().signal, () => undefined), /lmstudio\/qwen is not running/);
});
