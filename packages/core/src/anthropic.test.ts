import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderFactory } from "@kesher/providers";
import type { AgentMessage } from "@kesher/shared";
import { createKesherServer } from "./server.js";

/** Calls get_weather when it has the tool and no result yet; then answers from the result. */
const factory: ProviderFactory = {
  type: "toolish",
  displayName: "Toolish",
  categories: ["chat"],
  create: (config) => ({
    id: config.id,
    name: "Toolish",
    location: "local",
    capabilities: { chat: true, tools: true },
    checkHealth: async () => true,
    listModels: async () => [{ id: `${config.id}/m`, providerId: config.id, providerModelId: "m", name: "M", category: "chat", location: "local" }],
    chatWithTools: async (req, _signal, onText) => {
      const msgs = req.messages as AgentMessage[];
      const last = msgs.at(-1)!;
      if (last.role === "tool") {
        const t = `<think>ok</think>It is ${last.content} (${last.toolName}).`;
        for (const part of [t.slice(0, 12), t.slice(12)]) onText?.(part);
        return { text: t, toolCalls: [] };
      }
      if (req.tools.some((x) => x.name === "get_weather")) return { text: "", toolCalls: [{ id: "c1", name: "get_weather", arguments: { city: "Haifa" } }] };
      const sys = msgs.find((m) => m.role === "system")?.content ?? "";
      const text = `${sys ? `[${sys}] ` : ""}${last.content}${last.images?.length ? " +img" : ""}`;
      onText?.(text);
      return { text, toolCalls: [] };
    },
  }),
};

test("Anthropic Messages API: text, system, images, tools, streaming, and app keys", async () => {
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-anth-")), autodetect: false, pluginRoots: [] });
  server.services.registry.registerFactory(factory);
  const app = server.app;
  const post = (payload: unknown, headers: Record<string, string> = {}, remoteAddress?: string) => app.inject({ method: "POST", url: "/v1/messages", payload: payload as object, headers: { "anthropic-version": "2023-06-01", ...headers }, ...(remoteAddress ? { remoteAddress } : {}) });
  try {
    await app.inject({ method: "POST", url: "/api/providers", payload: { id: "t", type: "toolish" } });
    await app.inject({ method: "PUT", url: "/api/settings", payload: { activeModels: { chat: "t/m" } } });

    const a = (await post({ model: "claude-sonnet-4-5", max_tokens: 100, system: "Be brief", messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }] }] })).json() as { type: string; content: Array<{ type: string; text: string }>; stop_reason: string; usage: { input_tokens: number } };
    assert.equal(a.type, "message");
    assert.deepEqual(a.content, [{ type: "text", text: "[Be brief] hi +img" }]);
    assert.equal(a.stop_reason, "end_turn");
    assert.ok(a.usage.input_tokens > 0);

    const tools = [{ name: "get_weather", description: "Weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }];
    const t1 = (await post({ model: "t/m", max_tokens: 100, tools, messages: [{ role: "user", content: "weather?" }] })).json() as { content: Array<{ type: string; id: string; name: string; input: unknown }>; stop_reason: string };
    assert.equal(t1.stop_reason, "tool_use");
    assert.deepEqual(t1.content, [{ type: "tool_use", id: "toolu_c1", name: "get_weather", input: { city: "Haifa" } }]);

    const second = { model: "t/m", max_tokens: 100, tools, stream: true, messages: [{ role: "user", content: "weather?" }, { role: "assistant", content: t1.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_c1", content: "sunny" }] }] };
    const sse = (await post(second)).body;
    const events = [...sse.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    assert.deepEqual(events, ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    const text = [...sse.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]).join("");
    assert.equal(text, "It is sunny (get_weather).");

    const count = (await app.inject({ method: "POST", url: "/v1/messages/count_tokens", payload: { model: "t/m", messages: [{ role: "user", content: "hello world" }] } })).json() as { input_tokens: number };
    assert.ok(count.input_tokens > 0);
    const models = (await app.inject({ method: "GET", url: "/v1/models", headers: { "anthropic-version": "2023-06-01" } })).json() as { data: Array<{ type: string; id: string }> };
    assert.deepEqual(models.data[0], { type: "model", id: "t/m", display_name: "M", created_at: "2025-01-01T00:00:00Z" });

    // App keys: other devices need one (or the remote token); revoking stops it.
    const body = { model: "t/m", max_tokens: 10, messages: [{ role: "user", content: "x" }] };
    assert.equal((await post(body, {}, "192.168.1.9")).statusCode, 401);
    const made = (await app.inject({ method: "POST", url: "/api/api-keys", payload: { name: "Cursor" } })).json() as { key: string; entry: { id: string; prefix: string } };
    assert.match(made.key, /^kai-/);
    assert.equal((await post(body, { "x-api-key": made.key }, "192.168.1.9")).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", remoteAddress: "192.168.1.9", headers: { authorization: `Bearer ${made.key}` }, payload: { model: "t/m", messages: [{ role: "user", content: "x" }] } })).statusCode, 400, "the key passes auth (this fake model has no plain chat)");
    assert.equal((await app.inject({ method: "GET", url: "/api/settings", remoteAddress: "192.168.1.9", headers: { authorization: `Bearer ${made.key}` } })).statusCode, 401, "keys do not open the rest of the API");
    const list = (await app.inject({ method: "GET", url: "/api/api-keys" })).json() as { keys: Array<{ uses: number; hash?: string }> };
    assert.equal(list.keys[0]!.uses, 2);
    assert.equal(list.keys[0]!.hash, undefined);
    await app.inject({ method: "PUT", url: "/api/api-keys/settings", payload: { requireKeyLocally: true } });
    assert.equal((await post(body)).statusCode, 401, "this computer needs a key too now");
    assert.equal((await post(body, { "x-api-key": made.key })).statusCode, 200);
    const log = (await app.inject({ method: "GET", url: "/api/api-keys/log" })).json() as Array<{ caller: string; path: string; model?: string; status: number }>;
    assert.ok(log.some((l) => l.caller === "Cursor" && l.path === "/v1/messages" && l.model === "t/m" && l.status === 200));
    await app.inject({ method: "DELETE", url: `/api/api-keys/${made.entry.id}` });
    assert.equal((await post(body, { "x-api-key": made.key })).statusCode, 401);
  } finally {
    await server.close();
  }
});
