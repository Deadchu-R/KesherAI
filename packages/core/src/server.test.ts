import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amdCardOnLinux, createKesherServer } from "./server.js";
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

test("plugin tools run through /api/tools", async () => {
  const server = await makeServer();
  try {
    const res = await server.app.inject({ method: "POST", url: "/api/tools/reverse_text", payload: { text: "abc" } });
    assert.deepEqual(res.json(), { result: "cba" });
  } finally {
    await server.close();
  }
});

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

test("amdCardOnLinux: an AMD card with at least 4 GB of its own memory", async () => {
  // The sysfs tree is faked in a temp folder (the same way hardware-gpus.test.ts reads fake /sys).
  const cardIn = async (dir: string, n: string, vendor: string, vram?: string) => {
    const dev = join(dir, n, "device");
    await mkdir(dev, { recursive: true });
    await writeFile(join(dev, "vendor"), `${vendor}\n`);
    if (vram) await writeFile(join(dev, "mem_info_vram_total"), vram);
  };
  const root = await mkdtemp(join(tmpdir(), "kesher-drm-"));
  await cardIn(root, "card0", "0x1002", String(4 * 1024 ** 3)); // AMD, exactly 4 GB → yes
  // A real card also shows its monitor connectors (card0-HDMI-A-1): they are not cards.
  await mkdir(join(root, "card0-HDMI-A-1"), { recursive: true });
  if (process.platform === "linux") {
    // The full detection matrix only works where /sys/class/drm really is the kernel's.
    assert.equal(await amdCardOnLinux(root), true);
    await cardIn(root, "card1", "0x1002", String(2 * 1024 ** 3)); // an AMD card with too little memory is ignored
    assert.equal(await amdCardOnLinux(root), true);
    const none = await mkdtemp(join(tmpdir(), "kesher-drm-"));
    await cardIn(none, "card0", "0x10de", "16384"); // NVIDIA is reported by nvidia-smi, not /sys
    await cardIn(none, "card1", "0x1002", String(2 * 1024 ** 3)); // AMD but only 2 GB → no
    assert.equal(await amdCardOnLinux(none), false);
    // A folder with no cards at all.
    assert.equal(await amdCardOnLinux(await mkdtemp(join(tmpdir(), "kesher-drm-"))), false);
    // The real tree: whatever the computer has, it must answer without crashing.
    const real = await amdCardOnLinux();
    assert.equal(typeof real, "boolean");
  } else {
    // Not Linux: the guard answers no, even for a fake tree with an AMD card.
    assert.equal(await amdCardOnLinux(root), false);
  }
});

test("a shared project: invite, join from outside, read, write in their own chat only, nothing else", async () => {
  const server = await makeServer();
  try {
    assert.equal((await server.app.inject({ method: "POST", url: "/api/providers", payload: { id: "echo", type: "echo" } })).statusCode, 200);
    server.services.config.activeModels.chat = "echo/echo-1";
    const project = (await server.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Game" } })).json() as { id: string };
    const owners = (await server.app.inject({ method: "POST", url: "/api/conversations", payload: { kind: "chat", projectId: project.id } })).json() as { id: string };
    const invite = (await server.app.inject({ method: "POST", url: `/api/projects/${project.id}/invites`, payload: { role: "edit", hours: 1 } })).json() as { token: string };
    const away = { remoteAddress: "203.0.113.7", headers: { host: "kesher.example" } };
    // The link, from outside, with no key.
    assert.equal(((await server.app.inject({ url: `/api/join/${invite.token}`, ...away })).json() as { project: string }).project, "Game");
    const joined = (await server.app.inject({ method: "POST", url: `/api/join/${invite.token}`, payload: { name: "Dani" }, ...away })).json() as { key: string };
    assert.match(joined.key, /^kd_/);
    assert.equal((await server.app.inject({ method: "POST", url: `/api/join/${invite.token}`, payload: { name: "Again" }, ...away })).statusCode, 404, "the link works once");
    const as = { remoteAddress: "203.0.113.7", headers: { host: "kesher.example", authorization: `Bearer ${joined.key}` } };
    assert.equal(((await server.app.inject({ url: "/api/guest/me", ...as })).json() as { project: string }).project, "Game");
    // Nothing outside the guest API.
    for (const url of ["/api/conversations", "/api/settings", `/api/conversations/${owners.id}`, "/api/models", `/api/projects/${project.id}/guests`]) {
      assert.equal((await server.app.inject({ url, ...as })).statusCode, 403, url);
    }
    // The owner's chat: readable, not writable.
    assert.equal((await server.app.inject({ url: `/api/guest/chats/${owners.id}`, ...as })).statusCode, 200);
    assert.equal((await server.app.inject({ method: "POST", url: `/api/guest/chats/${owners.id}/messages`, payload: { text: "hi" }, ...as })).statusCode, 403);
    // Their own chat: no tools, written and answered.
    const mine = (await server.app.inject({ method: "POST", url: "/api/guest/chats", ...as })).json() as { id: string };
    assert.equal((await server.app.inject({ method: "POST", url: `/api/guest/chats/${mine.id}/messages`, payload: { text: "hello" }, ...as })).statusCode, 200);
    const summary = server.services.library.summary(mine.id);
    assert.equal(summary?.source, "guest");
    assert.equal(summary?.incognito, true);
    // The owner sees them and removes them: the key stops at once.
    const g = (await server.app.inject({ url: `/api/projects/${project.id}/guests` })).json() as { people: Array<{ id: string; name: string }> };
    assert.equal(g.people.length, 1);
    assert.equal((await server.app.inject({ method: "DELETE", url: `/api/projects/${project.id}/guests/${g.people[0]!.id}` })).statusCode, 200);
    assert.notEqual((await server.app.inject({ url: "/api/guest/me", ...as })).statusCode, 200);
  } finally {
    await server.close();
  }
});

test("an email invite: only that Google account joins; the wrong account and a banned one cannot", async () => {
  const server = await makeServer();
  const realFetch = globalThis.fetch;
  let who = "dani@example.com";
  const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ aud: "abc123.apps.googleusercontent.com", sub: `s-${email}`, email, email_verified: true, name: "Dani K" })).toString("base64url")}.sig`;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === "https://oauth2.googleapis.com/device/code") return new Response(JSON.stringify({ device_code: "dev1", user_code: "ABCD-EFGH", verification_url: "https://www.google.com/device", interval: 5, expires_in: 1800 }));
    if (u === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ id_token: idToken(who), access_token: "a" }));
    return realFetch(url, init);
  }) as typeof fetch;
  try {
    const project = (await server.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Game" } })).json() as { id: string };
    assert.equal((await server.app.inject({ method: "POST", url: `/api/projects/${project.id}/invites`, payload: { role: "read", email: "Dani@Example.com" } })).statusCode, 400, "Google must be set up first");
    assert.equal((await server.app.inject({ method: "PUT", url: "/api/guests/google", payload: { clientId: "abc123.apps.googleusercontent.com", clientSecret: "GOCSPX-secret12345" } })).statusCode, 200);
    const away = { remoteAddress: "203.0.113.8", headers: { host: "kesher.example" } };
    const join = async () => {
      const inv = (await server.app.inject({ method: "POST", url: `/api/projects/${project.id}/invites`, payload: { role: "read", email: "Dani@Example.com" } })).json() as { token: string };
      const info = (await server.app.inject({ url: `/api/join/${inv.token}`, ...away })).json() as { google: boolean; emailHint: string };
      assert.equal(info.google, true);
      assert.match(info.emailHint, /^d•+@example\.com$/);
      assert.equal((await server.app.inject({ method: "POST", url: `/api/join/${inv.token}`, payload: { name: "Anyone" }, ...away })).statusCode, 403, "a name is not enough");
      assert.equal(((await server.app.inject({ method: "POST", url: `/api/join/${inv.token}/google`, payload: { op: "start" }, ...away })).json() as { userCode: string }).userCode, "ABCD-EFGH");
      return server.app.inject({ method: "POST", url: `/api/join/${inv.token}/google`, payload: { op: "check" }, ...away });
    };
    who = "someone@else.com";
    assert.equal((await join()).statusCode, 403, "the wrong account");
    who = "dani@example.com";
    const ok = (await join()).json() as { key: string };
    assert.match(ok.key, /^kd_/);
    const g = (await server.app.inject({ url: `/api/projects/${project.id}/guests` })).json() as { people: Array<{ id: string; email: string }> };
    assert.equal(g.people[0]!.email, "dani@example.com");
    assert.equal((await server.app.inject({ method: "POST", url: `/api/projects/${project.id}/guests/${g.people[0]!.id}/ban` })).statusCode, 200);
    assert.equal((await server.app.inject({ method: "POST", url: `/api/projects/${project.id}/invites`, payload: { role: "read", email: "dani@example.com" } })).statusCode, 400, "banned: no new invite");
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
  }
});
