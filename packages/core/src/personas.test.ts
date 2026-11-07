import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderFactory } from "@kesher/providers";
import type { AgentMessage } from "@kesher/shared";
import { createKesherServer } from "./server.js";

/** Answers with whether the system prompt has the pirate persona, and which model it is. */
const factory: ProviderFactory = {
  type: "echo-system",
  displayName: "Echo",
  categories: ["chat"],
  create: (config) => ({
    id: config.id,
    name: "Echo",
    location: "local",
    capabilities: { chat: true, tools: true },
    checkHealth: async () => true,
    listModels: async () => ["a", "b"].map((m) => ({ id: `${config.id}/${m}`, providerId: config.id, providerModelId: m, name: m, category: "chat" as const, location: "local" as const })),
    chatWithTools: async (req) => {
      const sys = (req.messages as AgentMessage[]).filter((m) => m.role === "system").map((m) => m.content).join("\n");
      const text = `${req.providerModelId}:${/Speak like a pirate/.test(sys) ? "pirate" : "plain"}`;
      return { text, toolCalls: [] };
    },
  }),
};

test("personas: saved, start a chat with their model and instructions, and can be switched off", async () => {
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-persona-")), autodetect: false, pluginRoots: [] });
  server.services.registry.registerFactory(factory);
  const app = server.app;
  try {
    await app.inject({ method: "POST", url: "/api/providers", payload: { id: "e", type: "echo-system" } });
    await app.inject({ method: "PUT", url: "/api/settings", payload: { activeModels: { chat: "e/a" } } });
    const list = (await app.inject({ method: "GET", url: "/api/personas" })).json() as { personas: unknown[]; templates: unknown[] };
    assert.equal(list.personas.length, 0);
    assert.ok(list.templates.length >= 3);
    assert.equal((await app.inject({ method: "POST", url: "/api/personas", payload: { name: "x" } })).statusCode, 400);
    const p = (await app.inject({ method: "POST", url: "/api/personas", payload: { name: "Pirate", icon: "🏴‍☠️", instructions: "Speak like a pirate.", modelId: "e/b" } })).json() as { id: string };

    const c = (await app.inject({ method: "POST", url: "/api/conversations", payload: { kind: "chat", personaId: p.id } })).json() as { id: string; modelId: string; personaId: string };
    assert.equal(c.modelId, "e/b");
    assert.equal(c.personaId, p.id);
    const reply = async (text: string) => {
      await app.inject({ method: "POST", url: `/api/conversations/${c.id}/messages`, payload: { text } });
      const end = Date.now() + 3000;
      for (;;) {
        const conv = (await app.inject({ method: "GET", url: `/api/conversations/${c.id}` })).json() as { events: Array<{ type: string; text?: string }>; session: { status: string } };
        const texts = conv.events.filter((e) => e.type === "assistant").map((e) => e.text);
        const last = texts.at(-1);
        if (conv.session.status === "idle" && last && texts.length >= (text === "one" ? 1 : 2)) return last;
        if (Date.now() > end) throw new Error(`timed out ${JSON.stringify(conv.events.map((e) => e.type))}`);
        await new Promise((r) => setTimeout(r, 30));
      }
    };
    assert.equal(await reply("one"), "b:pirate");
    const off = (await app.inject({ method: "PATCH", url: `/api/conversations/${c.id}`, payload: { personaId: null } })).json() as { personaId?: string };
    assert.equal(off.personaId, undefined);
    assert.equal(await reply("two"), "b:plain");
    await app.inject({ method: "DELETE", url: `/api/personas/${p.id}` });
    assert.equal(((await app.inject({ method: "GET", url: "/api/personas" })).json() as { personas: unknown[] }).personas.length, 0);
  } finally {
    await server.close();
  }
});
