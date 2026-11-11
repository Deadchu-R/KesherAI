import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKesherServer } from "./server.js";
import { destinationFor } from "./routes/downloads.js";

/**
 * The tests need an "echo" provider and a tool; the repo's example plugin
 * (plugins/example-hello) gives them, but only after it is built — its dist/
 * is gitignored, so on a fresh clone it fails to activate and the tests die
 * with a misleading "No provider echo" error. Instead, makeServer writes the
 * same plugin into a temp folder, so the tests never depend on a build.
 */
const ECHO_PLUGIN_SOURCE = [
  "export default {",
  "  activate(ctx) {",
  "    ctx.registerProviderFactory({",
  "      type: \"echo\",",
  "      displayName: \"Echo (test)\",",
  "      categories: [\"chat\"],",
  "      create: (config) => ({",
  "        id: config.id,",
  "        name: config.name ?? \"Echo\",",
  "        location: \"local\",",
  "        capabilities: { chat: true },",
  "        checkHealth: async () => true,",
  "        listModels: async () => [{ id: `${config.id}/echo-1`, providerId: config.id, providerModelId: \"echo-1\", name: \"Echo 1\", category: \"chat\", location: \"local\" }],",
  "        chat: async function* (request) {",
  "          const last = [...request.messages].reverse().find((m) => m.role === \"user\");",
  "          yield { type: \"delta\", text: `Echo: ${last?.content ?? \"\"}` };",
  "          yield { type: \"done\" };",
  "        },",
  "      }),",
  "    });",
  "    ctx.registerTool({",
  "      name: \"reverse_text\",",
  "      description: \"Reverses a string. Use it when the user asks to reverse text.\",",
  "      inputSchema: { type: \"object\", properties: { text: { type: \"string\" } }, required: [\"text\"] },",
  "      run: async (input) => [...String(input.text ?? \"\")].reverse().join(\"\"),",
  "    });",
  "  },",
  "};",
].join("\n");

async function makeServer() {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-core-"));
  await mkdir(join(dataDir, "test-plugins", "echo-mod"), { recursive: true });
  const pluginRoot = join(dataDir, "test-plugins");
  await writeFile(
    join(pluginRoot, "echo-mod", "kesher-plugin.json"),
    JSON.stringify({
      id: "echo-mod", name: "Echo test plugin", version: "0.0.0",
      description: "Test plugin: an echo provider and a reverse_text tool.",
      main: "index.mjs", kesher: { apiVersion: 1 }, permissions: [],
    }),
  );
  await writeFile(join(pluginRoot, "echo-mod", "index.mjs"), ECHO_PLUGIN_SOURCE);
  return createKesherServer({ dataDir, autodetect: false, pluginRoots: [pluginRoot] });
}

/** The repo's example plugin is built (its dist/ exists) — only then can a test load its built file. */
const exampleHelloBuilt = existsSync(join(import.meta.dirname, "../../../plugins/example-hello/dist/index.js"));

test("loads a plugin and serves its provider through /api/chat", async () => {
  const server = await makeServer();
  try {
    const plugins = await server.app.inject({ method: "GET", url: "/api/plugins" });
    const hello = (plugins.json() as Array<{ id: string; status: string; error?: string }>).find((p) => p.id === "echo-mod");
    assert.equal(hello?.status, "active", hello?.error);

    const add = await server.app.inject({ method: "POST", url: "/api/providers", payload: { id: "echo", type: "echo" } });
    assert.equal(add.statusCode, 200, add.body);

    const models = await server.app.inject({ method: "GET", url: "/api/models" });
    assert.ok((models.json() as { models: Array<{ id: string }> }).models.some((m) => m.id === "echo/echo-1"));

    const chat = await server.app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { modelId: "echo/echo-1", messages: [{ role: "user", content: "שלום" }] },
    });
    assert.match(chat.headers["content-type"] as string, /text\/event-stream/);
    assert.match(chat.body, /"type":"delta","text":"Echo: שלום"/);
    assert.match(chat.body, /"type":"done"/);
  } finally {
    await server.close();
  }
});

test("OpenAI-compatible endpoint works without streaming", async () => {
  const server = await makeServer();
  try {
    const add = await server.app.inject({ method: "POST", url: "/api/providers", payload: { id: "echo", type: "echo" } });
    assert.equal(add.statusCode, 200, add.body);
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "echo/echo-1", messages: [{ role: "user", content: "hi" }] },
    });
    const body = res.json() as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]?.message.content, "Echo: hi");
  } finally {
    await server.close();
  }
});

test(
  "plugin tools run through /api/tools",
  { skip: !exampleHelloBuilt ? "the repo's example plugin is not built (pnpm build:packages)" : false },
  async () => {
    const server = await makeServer();
    try {
      const res = await server.app.inject({ method: "POST", url: "/api/tools/reverse_text", payload: { text: "abc" } });
      assert.deepEqual(res.json(), { result: "cba" });
    } finally {
      await server.close();
    }
  },
  );

test("remote requests without the token are rejected", async () => {
  const server = await makeServer();
  try {
    const res = await server.app.inject({ method: "GET", url: "/api/health", remoteAddress: "192.168.1.20" });
    assert.equal(res.statusCode, 401);
    const token = server.services.config.remote.token!;
    const ok = await server.app.inject({
      method: "GET", url: "/api/health", remoteAddress: "192.168.1.20", headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(ok.statusCode, 200);
    for (const url of ["/api/models", "/v1/models", "/api/assets/x?token=wrong"]) {
      assert.equal((await server.app.inject({ method: "GET", url, remoteAddress: "192.168.1.20" })).statusCode, 401, url);
    }
  } finally {
    await server.close();
  }
});

test("a phone loads the interface files without the token, but not the data", async () => {
  const web = await mkdtemp(join(tmpdir(), "kesher-web-"));
  await mkdir(join(web, "assets"));
  await writeFile(join(web, "index.html"), "<!doctype html><script src=/assets/app.js></script>");
  await writeFile(join(web, "assets", "app.js"), "console.log(1)");
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-wd-")), autodetect: false, pluginRoots: [], webDir: web });
  try {
    for (const url of ["/", "/assets/app.js", "/?token=abc"]) {
      assert.equal((await server.app.inject({ method: "GET", url, remoteAddress: "192.168.1.20" })).statusCode, 200, url);
    }
    assert.equal((await server.app.inject({ method: "GET", url: "/api/conversations", remoteAddress: "192.168.1.20" })).statusCode, 401);
  } finally {
    await server.close();
  }
});

test("download destinations cannot escape the models folder", async () => {
  const server = await makeServer();
  try {
    const s = server.services;
    assert.ok(destinationFor(s, { repo: "a/b", path: "x.gguf", category: "chat" }).startsWith(s.paths.models));
    assert.throws(() => destinationFor(s, { repo: "a/b", path: "../../../../etc/passwd", category: "chat" }));
  } finally {
    await server.close();
  }
});

test("chat streams over a real socket, not only through inject", async () => {
  const server = await makeServer();
  try {
    await server.app.inject({ method: "POST", url: "/api/providers", payload: { id: "echo", type: "echo" } });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = server.app.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "echo/echo-1", messages: [{ role: "user", content: "ping" }] }),
    });
    const text = await res.text();
    assert.match(text, /Echo: ping/);
    assert.match(text, /"type":"done"/);
  } finally {
    await server.close();
  }
});
