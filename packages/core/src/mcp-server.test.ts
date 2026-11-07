import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderFactory } from "@kesher/providers";
import type { AgentMessage } from "@kesher/shared";
import { createKesherServer } from "./server.js";

const factory: ProviderFactory = {
  type: "upper",
  displayName: "Upper",
  categories: ["chat"],
  create: (config) => ({
    id: config.id,
    name: "Upper",
    location: "local",
    capabilities: { chat: true, tools: true },
    checkHealth: async () => true,
    listModels: async () => [{ id: `${config.id}/m`, providerId: config.id, providerModelId: "m", name: "m", category: "chat", location: "local" }],
    chatWithTools: async (req) => ({ text: `<think>hmm</think>${(req.messages as AgentMessage[]).at(-1)!.content.toUpperCase()}`, toolCalls: [] }),
  }),
};

test("KesherAI as an MCP server: initialize, list tools, ask a local model, turn off", async () => {
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-mcps-")), autodetect: false, pluginRoots: [] });
  server.services.registry.registerFactory(factory);
  const app = server.app;
  const rpc = async (method: string, params: Record<string, unknown> = {}, id: number | null = 1) =>
    app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params } });
  try {
    await app.inject({ method: "POST", url: "/api/providers", payload: { id: "u", type: "upper" } });
    await app.inject({ method: "PUT", url: "/api/settings", payload: { activeModels: { chat: "u/m" } } });
    const init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } })).json() as { result: { protocolVersion: string; capabilities: { tools: unknown } } };
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.ok(init.result.capabilities.tools);
    assert.equal((await rpc("notifications/initialized", {}, null)).statusCode, 202);
    const tools = ((await rpc("tools/list")).json() as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    assert.deepEqual(tools, ["list_models", "ask_model", "search_knowledge", "generate_image", "transcribe_audio"]);
    const ask = (await rpc("tools/call", { name: "ask_model", arguments: { prompt: "shalom" } })).json() as { result: { content: Array<{ text: string }>; isError: boolean } };
    assert.deepEqual(ask.result, { content: [{ type: "text", text: "SHALOM" }], isError: false });
    const models = (await rpc("tools/call", { name: "list_models", arguments: {} })).json() as { result: { content: Array<{ text: string }> } };
    assert.match(models.result.content[0]!.text, /u\/m — m \(chat, local\) \[active\]/);
    const img = (await rpc("tools/call", { name: "generate_image", arguments: { prompt: "x" } })).json() as { result: { isError: boolean } };
    assert.equal(img.result.isError, true);
    assert.equal(((await rpc("nope")).json() as { error: { code: number } }).error.code, -32601);
    const info = (await app.inject({ method: "GET", url: "/api/mcp-server" })).json() as { url: string; snippets: Record<string, string> };
    assert.match(info.snippets.claudeCode!, /claude mcp add --transport http kesherai http:\/\/127\.0\.0\.1:\d+\/mcp/);
    assert.ok(info.snippets.claudeDesktop, "the stdio bridge is found in the repository");
    await app.inject({ method: "PUT", url: "/api/mcp-server", payload: { enabled: false } });
    assert.equal((await rpc("tools/list")).statusCode, 403);
    // Other devices need the remote access token.
    const remote = await app.inject({ method: "POST", url: "/mcp", remoteAddress: "192.168.1.20", payload: { jsonrpc: "2.0", id: 1, method: "ping" } });
    assert.equal(remote.statusCode, 401);
  } finally {
    await server.close();
  }
});
