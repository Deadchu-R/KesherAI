import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderFactory } from "@kesher/providers";
import type { AgentMessage } from "@kesher/shared";
import { createKesherServer } from "./server.js";

/** What a chat's first model request held. */
interface Seen {
  messages: AgentMessage[];
  tools: Array<{ name: string }>;
}

/** A local model that records the requests of the chats' first step and answers in one line. */
function recorder(seen: Seen[]): ProviderFactory {
  return {
    type: "recorder",
    displayName: "Recorder",
    categories: ["chat"],
    create: (config) => ({
      id: config.id,
      name: "Recorder",
      location: "local",
      capabilities: { chat: true, tools: true },
      checkHealth: async () => true,
      listModels: async () => [{ id: `${config.id}/m`, providerId: config.id, providerModelId: "m", name: "m", category: "chat", location: "local" }],
      chatWithTools: async (req, _signal, onText) => {
        const last = req.messages.at(-1) as AgentMessage;
        if (last.role === "user" && !last.content.startsWith("You keep a memory about the user")) seen.push(structuredClone({ messages: req.messages, tools: req.tools }) as Seen);
        onText?.("ok");
        return { text: "ok", toolCalls: [] };
      },
    }),
  };
}

/**
 * Budget for what every new chat sends before its own words: the system turn plus the tool specs that come before
 * the per-message tools, measured on the real tool set at 4 characters a token. Today (28.11) it is about 5,700; the
 * limit leaves room for small additions only. If this fails, shorten what grew or move it to a tool loaded on demand
 * (find_tools); a big prefix is read again by every new chat on a local engine whose cache is cold.
 */
const PREFIX_BUDGET_TOKENS = 6_500;

test("two real chats start their request the same way, and that start stays under its budget", async () => {
  const seen: Seen[] = [];
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-prefix-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  try {
    server.services.registry.registerFactory(recorder(seen));
    await server.app.inject({ method: "POST", url: "/api/providers", payload: { id: "fake", type: "recorder" } });
    await server.app.inject({ method: "PUT", url: "/api/settings", payload: { activeModels: { chat: "fake/m" } } });
    for (const text of ["What is the weather forecast for Haifa tomorrow?", "כתוב לי שיר קצר על הים"]) {
      const created = (await server.app.inject({ method: "POST", url: "/api/conversations", payload: { kind: "chat" } })).json() as { id: string };
      const sent = await server.app.inject({ method: "POST", url: `/api/conversations/${created.id}/messages`, payload: { text } });
      assert.equal(sent.statusCode, 200, sent.body);
      const end = Date.now() + 5000;
      while (seen.length < (text.startsWith("What") ? 1 : 2) && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(seen.length, 2);
    const [a, b] = seen as [Seen, Seen];
    assert.equal(a.messages[0]!.role, "system");
    assert.equal(a.messages[0]!.content, b.messages[0]!.content, "the system turn is the same in every chat");
    // The tools both chats send, identical and in the same order, before what a message loaded and more_tools.
    let n = 0;
    while (n < a.tools.length && n < b.tools.length && JSON.stringify(a.tools[n]) === JSON.stringify(b.tools[n])) n++;
    const lead = a.tools.slice(0, n).map((t) => t.name);
    assert.ok(lead.length >= 20, `the chats share only ${lead.length} tools at the start: ${a.tools.map((t) => t.name).join(",")} / ${b.tools.map((t) => t.name).join(",")}`);
    assert.ok(!lead.includes("more_tools"));
    const tokens = Math.ceil((a.messages[0]!.content.length + JSON.stringify(a.tools.slice(0, lead.length)).length) / 4);
    console.log(`shared prefix: ${tokens} tokens (system ${Math.ceil(a.messages[0]!.content.length / 4)}, ${lead.length} tools ${Math.ceil(JSON.stringify(a.tools.slice(0, lead.length)).length / 4)}; all tools of chat 1: ${a.tools.length}, ${Math.ceil(JSON.stringify(a.tools).length / 4)} tokens)`);
    assert.ok(tokens <= PREFIX_BUDGET_TOKENS, `the shared prefix is ${tokens} tokens, over the budget of ${PREFIX_BUDGET_TOKENS}`);
  } finally {
    await server.close();
  }
});
