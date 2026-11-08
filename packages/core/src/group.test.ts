import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderFactory } from "@kesher/providers";
import type { AgentMessage } from "@kesher/shared";
import { createKesherServer } from "./server.js";

/** The lead asks the designer for its part, then sums up; a member answers from its own instructions. */
const factory: ProviderFactory = {
  type: "group-fake",
  displayName: "Fake",
  categories: ["chat"],
  create: (config) => ({
    id: config.id,
    name: "Fake",
    location: "local",
    capabilities: { chat: true, tools: true },
    checkHealth: async () => true,
    listModels: async () => [{ id: `${config.id}/m`, providerId: config.id, providerModelId: "m", name: "m", category: "chat", location: "local" }],
    chatWithTools: async (req) => {
      const sys = String((req.messages[0] as AgentMessage).content);
      const last = req.messages.at(-1) as AgentMessage;
      if (/You are Designer, one member of a group/.test(sys)) return { text: "A blue logo with a fox.", toolCalls: [] };
      if (last.role === "user" && req.tools.some((t) => t.name === "ask_member")) {
        assert.match(sys, /You lead a group of assistants: Designer \(Draws logos/);
        return { text: "", toolCalls: [{ id: "a1", name: "ask_member", arguments: { member: "Designer", task: "Design a logo for a fox café." } }] };
      }
      if (last.role === "tool") return { text: `Done. Designer: ${String(last.content).split("\n")[1]}`, toolCalls: [] };
      return { text: "plain answer", toolCalls: [] };
    },
  }),
};

test("agent group: the lead asks a member for its part and puts it together", async () => {
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-group-")), autodetect: false, pluginRoots: [] });
  server.services.registry.registerFactory(factory);
  const app = server.app;
  try {
    await app.inject({ method: "POST", url: "/api/providers", payload: { id: "fake", type: "group-fake" } });
    const persona = (await app.inject({ method: "POST", url: "/api/personas", payload: { name: "Designer", icon: "🎨", instructions: "Draws logos and picks colors." } })).json() as { id: string };
    const conv = (await app.inject({ method: "POST", url: "/api/conversations", payload: { kind: "chat", modelId: "fake/m" } })).json() as { id: string };
    const patched = await app.inject({ method: "PATCH", url: `/api/conversations/${conv.id}`, payload: { group: [persona.id] } });
    assert.equal(patched.statusCode, 200);
    await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, payload: { text: "Make me a logo idea" } });
    let events: Array<{ type: string; text?: string; name?: string; output?: string }> = [];
    for (let i = 0; i < 100; i++) {
      events = ((await app.inject({ method: "GET", url: `/api/conversations/${conv.id}` })).json() as { events: typeof events }).events;
      if (events.some((e) => e.type === "assistant" && /Done/.test(e.text ?? ""))) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    const result = events.find((e) => e.type === "tool_result");
    assert.match(result?.output ?? "", /^🎨 Designer \(m\):\nA blue logo with a fox\./);
    assert.ok(events.some((e) => e.type === "assistant" && e.text === "Done. Designer: A blue logo with a fox."));
    assert.equal((await app.inject({ method: "PATCH", url: `/api/conversations/${conv.id}`, payload: { group: "x" } })).statusCode, 400);
  } finally {
    await server.close();
  }
});
