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
    assert.deepEqual(tools, ["kesher_chat", "kesher_read", "kesher_list_chats", "kesher_approve", "list_models", "ask_model", "search_knowledge", "generate_image", "transcribe_audio"]);
    const ask = (await rpc("tools/call", { name: "ask_model", arguments: { prompt: "shalom" } })).json() as { result: { content: Array<{ text: string }>; isError: boolean } };
    assert.deepEqual(ask.result, { content: [{ type: "text", text: "SHALOM" }], isError: false });
    const models = (await rpc("tools/call", { name: "list_models", arguments: {} })).json() as { result: { content: Array<{ text: string }> } };
    assert.match(models.result.content[0]!.text, /u\/m — m \(chat, local\) \[active\]/);
    // Giving KesherAI a task: a new chat, its answer and status come back.
    const chat = (await rpc("tools/call", { name: "kesher_chat", arguments: { text: "build it", wait_seconds: 10 } })).json() as { result: { content: Array<{ text: string }>; isError: boolean } };
    assert.equal(chat.result.isError, false);
    assert.match(chat.result.content[0]!.text, /conversation_id: [\w-]+\nstatus: DONE\.[\s\S]*KesherAI: BUILD IT/);
    const cid = /conversation_id: ([\w-]+)/.exec(chat.result.content[0]!.text)![1];
    const read = (await rpc("tools/call", { name: "kesher_read", arguments: { conversation_id: cid } })).json() as { result: { content: Array<{ text: string }> } };
    assert.match(read.result.content[0]!.text, /BUILD IT/);
    const chats = (await rpc("tools/call", { name: "kesher_list_chats", arguments: {} })).json() as { result: { content: Array<{ text: string }> } };
    assert.match(chats.result.content[0]!.text, /From Claude: build it/);
    // Approving KesherAI's cards from outside is off until the user turns it on.
    const appr = (await rpc("tools/call", { name: "kesher_approve", arguments: { conversation_id: cid, request_id: "x", decision: "allow" } })).json() as { result: { content: Array<{ text: string }>; isError: boolean } };
    assert.equal(appr.result.isError, true);
    assert.match(appr.result.content[0]!.text, /has not let other apps approve/);
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
