import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderFactory } from "@kesher/providers";
import type { AgentMessage } from "@kesher/shared";
import { createKesherServer } from "./server.js";
import { pagePrompt } from "./pages.js";

const factory: ProviderFactory = {
  type: "pages-fake",
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
      const last = String((req.messages.at(-1) as AgentMessage).content);
      return { text: /selected text/.test(last) ? "```markdown\nShort.\n```" : "## Next\nMore text.", toolCalls: [] };
    },
  }),
};

test("pages: write, ask the agent to change a selection or write on, export", async () => {
  assert.match(pagePrompt({ title: "T", content: "abc" }, { action: "shorter", selection: "abc" })[1]!.content, /shorter/);
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-pages-")), autodetect: false, pluginRoots: [] });
  server.services.registry.registerFactory(factory);
  const app = server.app;
  try {
    await app.inject({ method: "POST", url: "/api/providers", payload: { id: "fake", type: "pages-fake" } });
    server.services.config.activeModels.chat = "fake/m";
    const p = (await app.inject({ method: "POST", url: "/api/pages", payload: { title: "Plan" } })).json() as { id: string };
    await app.inject({ method: "PUT", url: `/api/pages/${p.id}`, payload: { content: "# Plan\nA long long paragraph." } });
    const list = (await app.inject({ method: "GET", url: "/api/pages" })).json() as Array<{ title: string; words: number }>;
    assert.equal(list[0]!.title, "Plan");
    assert.equal(list[0]!.words, 6);
    const short = (await app.inject({ method: "POST", url: `/api/pages/${p.id}/write`, payload: { action: "shorter", selection: "A long long paragraph." } })).json() as { text: string };
    assert.equal(short.text, "Short.");
    const more = (await app.inject({ method: "POST", url: `/api/pages/${p.id}/write`, payload: { instruction: "write the next part" } })).json() as { text: string };
    assert.equal(more.text, "## Next\nMore text.");
    const md = await app.inject({ method: "GET", url: `/api/pages/${p.id}/export?format=md` });
    assert.equal(md.body, "# Plan\nA long long paragraph.");
    const html = await app.inject({ method: "GET", url: `/api/pages/${p.id}/export?format=html` });
    assert.match(html.body, /<h2 dir="auto">Plan<\/h2>/);
    assert.equal((await app.inject({ method: "GET", url: "/api/pages/../x" })).statusCode >= 400, true);
  } finally {
    await server.close();
  }
});
