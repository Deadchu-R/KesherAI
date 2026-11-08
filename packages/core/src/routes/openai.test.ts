import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { ProviderRegistry } from "@kesher/providers";
import type { KesherServices } from "../services.js";
import { fromOpenAIMessages, openAIRoutes } from "./openai.js";

test("/v1/chat/completions passes tools and tool calls through (one computer using another's model)", async () => {
  const reg = new ProviderRegistry();
  let seen: { tools: unknown[]; messages: unknown[] } | undefined;
  reg.registerFactory({
    type: "fake",
    displayName: "Fake",
    categories: ["chat"],
    create: (config) => ({
      id: config.id,
      name: "Fake",
      location: "local",
      capabilities: { chat: true, tools: true },
      checkHealth: async () => true,
      listModels: async () => [],
      async *chat() {
        yield { type: "delta" as const, text: "plain" };
      },
      chatWithTools: async (r) => {
        seen = { tools: r.tools, messages: r.messages };
        return { text: "", toolCalls: [{ id: "c1", name: "unity_status", arguments: {} }] };
      },
    }),
  });
  reg.add({ id: "lm", type: "fake" });
  const app = Fastify();
  await openAIRoutes(app, { registry: reg } as unknown as KesherServices);
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "lm/qwen",
      messages: [
        { role: "user", content: "make tetris" },
        { role: "assistant", content: null, tool_calls: [{ id: "c0", function: { name: "unity_list_scripts", arguments: "{\"folder\":\"Assets\"}" } }] },
        { role: "tool", tool_call_id: "c0", content: "No code files" },
      ],
      tools: [{ type: "function", function: { name: "unity_status", description: "d", parameters: { type: "object", properties: {} } } }],
    },
  });
  const j = res.json() as { choices: Array<{ finish_reason: string; message: { tool_calls?: Array<{ function: { name: string } }> } }> };
  assert.equal(j.choices[0]!.finish_reason, "tool_calls");
  assert.equal(j.choices[0]!.message.tool_calls?.[0]?.function.name, "unity_status");
  assert.equal(seen?.tools.length, 1);
  const msgs = fromOpenAIMessages([{ role: "assistant", content: null, tool_calls: [{ id: "c0", function: { name: "x", arguments: "{\"a\":1}" } }] }, { role: "tool", tool_call_id: "c0", content: "ok" }]);
  assert.deepEqual(msgs[0]!.toolCalls, [{ id: "c0", name: "x", arguments: { a: 1 } }]);
  assert.equal(msgs[1]!.toolCallId, "c0");
  await app.close();
});
