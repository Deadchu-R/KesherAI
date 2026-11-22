import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, RequestError } from "@agentclientprotocol/sdk";
import { AcpAgent, readModels } from "./acp.js";

/** A fake `agy acp` that lists its models in ACP's `models` state, as Antigravity's plan shows them. */
function modelAgent(seen: { setModel?: string; prompts: string[] }, quotaOn = "") {
  let current = "gemini-3.8-flash";
  return agent()
    .onRequest("initialize", () => ({ protocolVersion: 1, agentInfo: { name: "fake-agy" }, authMethods: [] }))
    .onRequest("session/new", () => ({
      sessionId: "s1",
      models: {
        currentModelId: current,
        availableModels: [
          { modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash (Medium)" },
          { modelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6 (Thinking)" },
          { modelId: "claude-opus-4.6", name: "Claude Opus 4.6 (Thinking)" },
          { modelId: "gpt-oss-120b", name: "GPT-OSS 120B (Medium)" },
          { modelId: "gemini-4-neon", name: "Gemini 4 Neon", description: "Unavailable for your plan" },
        ],
      },
    }))
    // `session/set_model` is not in the SDK's stable list yet: the wildcard handler takes it with raw params.
    .onRequest("*", ((ctx: { method: string; params: { modelId?: string } }) => {
      if (ctx.method !== "session/set_model" || !ctx.params?.modelId) throw new Error("Method not found");
      seen.setModel = ctx.params.modelId;
      current = ctx.params.modelId;
      return {};
    }) as never)
    .onRequest("session/prompt", () => {
      seen.prompts.push(current);
      // As agy answers it: a JSON-RPC error whose message names the quota (a plain throw would arrive as "Internal error").
      if (current === quotaOn) throw new RequestError(-32000, "RESOURCE_EXHAUSTED: You have reached the quota for Claude and GPT models.");
      return { stopReason: "end_turn" as const };
    });
}

test("ACP models: read from `models`, unavailable ones marked, switched with session/set_model", async () => {
  const seen = { prompts: [] as string[] } as { setModel?: string; prompts: string[] };
  const a = await AcpAgent.connect(modelAgent(seen), { update: () => undefined, permission: async () => undefined });
  try {
    await a.newSession("/p");
    assert.deepEqual(a.sessionKeys, ["sessionId", "models"]);
    assert.equal(a.model, "gemini-3.8-flash");
    assert.equal(a.models.length, 5);
    assert.equal(a.models.find((m) => m.id === "gemini-4-neon")?.available, false, "an unavailable model is kept but marked");
    await a.setModel("claude-opus-4.6");
    assert.equal(seen.setModel, "claude-opus-4.6");
    assert.equal(a.model, "claude-opus-4.6");
    await assert.rejects(a.setModel("gemini-4-neon"), /does not offer/, "never an unavailable model");
    await a.prompt("x");
    assert.deepEqual(seen.prompts, ["claude-opus-4.6"]);
  } finally {
    a.close();
  }
});

test("ACP models: a configOptions model select works too (set through set_config_option)", () => {
  const options = [{ id: "model", name: "Model", category: "model", current: "a", choices: [{ value: "a", name: "Gemini 3.8 Flash" }, { value: "b", name: "Gemini 4 Carbon (Unavailable)" }] }];
  const r = readModels({ sessionId: "s" }, options);
  assert.equal(r.current, "a");
  assert.deepEqual(r.models.map((m) => [m.id, m.available, m.via]), [["a", true, "option"], ["b", false, "option"]]);
  assert.deepEqual(readModels(null, []).models, []);
});

export { modelAgent };
