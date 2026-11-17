import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRegistry } from "@kesher/providers";
import { PluginHost } from "./plugins.js";
import { KesherConfigSchema } from "./config.js";

test("a mod without code adds pages and styles, and a declared program becomes a tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-plugins-"));
  const mod = join(root, "my-mod");
  await mkdir(join(mod, "ui"), { recursive: true });
  await writeFile(join(mod, "ui", "page.html"), "<p>hi</p>");
  await writeFile(
    join(mod, "kesher-plugin.json"),
    JSON.stringify({
      id: "my-mod", name: "Mod", version: "1.0.0", kesher: { apiVersion: 1 }, permissions: ["shell"],
      ui: { pages: [{ id: "p", title: "P", file: "ui/page.html" }], styles: ["ui/theme.css"] },
      programs: [{ id: "hello", name: "Node", description: "Says hello.", command: process.execPath, args: ["-e", "console.log('hello from ' + process.argv[1])"], timeoutSeconds: 20 }],
    }),
  );
  const bad = join(root, "bad");
  await mkdir(bad);
  await writeFile(join(bad, "kesher-plugin.json"), JSON.stringify({ id: "bad", name: "B", version: "1", kesher: { apiVersion: 1 }, programs: [{ id: "x", name: "x", description: "x", command: "x" }] }));

  const host = new PluginHost(new ProviderRegistry(), KesherConfigSchema.parse({}), root);
  await host.loadAll([root]);
  assert.equal(host.list().find((p) => p.manifest.id === "my-mod")?.status, "active");
  assert.equal(host.list().some((p) => p.manifest.id === "bad"), false, "programs without the shell permission are rejected");
  assert.deepEqual(host.ui().pages.map((p) => `${p.pluginId}/${p.id}`), ["my-mod/p"]);
  assert.ok(host.fileOf("my-mod", "ui/page.html"));
  assert.equal(host.fileOf("my-mod", "../bad/kesher-plugin.json"), undefined);
  const tool = host.tools.get("my_mod_hello")!;
  const out = String(await tool.run({ args: ["KesherAI"] }, new AbortController().signal));
  assert.match(out, /hello from KesherAI/);
  assert.match(out, /exited with code 0/);
});

test("a plugin's code runs in its own process: tools and providers work across it; the network and programs it did not ask for are refused", async (t) => {
  const { rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "kesher-plugins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "boxed");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "kesher-plugin.json"), JSON.stringify({ id: "boxed", name: "Boxed", version: "1.0.0", main: "index.mjs", kesher: { apiVersion: 1 }, permissions: [] }));
  await writeFile(
    join(dir, "index.mjs"),
    `import net from "node:net";
export default {
  activate(ctx) {
    ctx.registerTool({ name: "boxed_pid", description: "pid", inputSchema: { type: "object" }, run: async (input) => ({ pid: process.pid, echo: input.x }) });
    ctx.registerTool({ name: "boxed_fetch", description: "fetch", inputSchema: { type: "object" }, run: async () => fetch("https://example.com") });
    ctx.registerTool({ name: "boxed_net", description: "net", inputSchema: { type: "object" }, run: async () => net.connect(80, "example.com") });
    ctx.registerTool({ name: "boxed_shell", description: "shell", inputSchema: { type: "object" }, run: async () => (await import("node:child_process")).execSync("echo hi") });
    ctx.registerTool({ name: "boxed_binding", description: "binding", inputSchema: { type: "object" }, run: async () => process.binding("tcp_wrap") });
    ctx.registerTool({ name: "boxed_stream_out", description: "stream outside", inputSchema: { type: "object" }, run: async () => { const fs = await import("node:fs"); new fs.ReadStream("/etc/hostname"); return "opened"; } });
    ctx.registerTool({ name: "boxed_env", description: "env", inputSchema: { type: "object" }, run: async () => process.env.KESHER_TEST_SECRET ?? "none" });
    ctx.registerTool({ name: "boxed_read_own_url", description: "own file by URL", inputSchema: { type: "object" }, run: async () => (await import("node:fs")).readFileSync(new URL(import.meta.url), "utf8").length > 0 });
    ctx.registerTool({ name: "boxed_read_out", description: "read outside", inputSchema: { type: "object" }, run: async () => (await import("node:fs")).readFileSync("/etc/hostname", "utf8") });
    ctx.registerTool({ name: "boxed_write_data", description: "write data", inputSchema: { type: "object" }, run: async () => { const fs = await import("node:fs/promises"); await fs.writeFile(ctx.dataDir + "/x.txt", "ok"); return fs.readFile(ctx.dataDir + "/x.txt", "utf8"); } });
    ctx.registerProviderFactory({ type: "boxed-echo", displayName: "Echo", categories: ["chat"], create: (config) => ({
      id: config.id, name: config.name, location: "local", capabilities: {},
      checkHealth: async () => true,
      listModels: async () => [{ id: "echo", name: "Echo" }],
      async *chat(req) { for (const w of String(req.messages.at(-1).content).split(" ")) yield { type: "text", text: w }; },
    }) });
  },
};`,
  );
  const registry = new ProviderRegistry();
  const host = new PluginHost(registry, KesherConfigSchema.parse({}), root);
  process.env.KESHER_TEST_SECRET = "sk-secret";
  await host.loadAll([root]);
  delete process.env.KESHER_TEST_SECRET;
  const rec = host.list().find((p) => p.manifest.id === "boxed")!;
  assert.equal(rec.status, "active", rec.error);
  assert.equal(rec.isolation?.process, true);
  const signal = new AbortController().signal;
  const r = (await host.tools.get("boxed_pid")!.run({ x: 7 }, signal)) as { pid: number; echo: number };
  assert.notEqual(r.pid, process.pid, "another process");
  assert.equal(r.echo, 7);
  await assert.rejects(host.tools.get("boxed_fetch")!.run({}, signal), /did not ask for the "network" permission/);
  await assert.rejects(host.tools.get("boxed_net")!.run({}, signal), /did not ask for the "network" permission/);
  await assert.rejects(host.tools.get("boxed_shell")!.run({}, signal), /did not ask for the "shell" permission/);
  await assert.rejects(host.tools.get("boxed_binding")!.run({}, signal), /internal bindings/);
  // Files: only its own folders without "filesystem" (where Node's own sandbox is not used).
  await assert.rejects(host.tools.get("boxed_read_out")!.run({}, signal), /did not ask for the "filesystem" permission/);
  assert.equal(await host.tools.get("boxed_write_data")!.run({}, signal), "ok");
  await assert.rejects(host.tools.get("boxed_stream_out")!.run({}, signal), /"filesystem" permission/);
  assert.equal(await host.tools.get("boxed_read_own_url")!.run({}, signal), true, "its own file, given as a file: URL (as Node's loaders do)");
  assert.equal(await host.tools.get("boxed_env")!.run({}, signal), "none", "KesherAI's environment (keys) does not reach a plugin");
  // A provider whose stream crosses the processes.
  const factory = (registry as unknown as { factories: Map<string, { create(c: unknown): { chat(r: unknown): AsyncIterable<{ text: string }>; listModels(): Promise<unknown[]> } }> }).factories.get("boxed-echo")!;
  const provider = factory.create({ id: "e", type: "boxed-echo", name: "E" });
  assert.equal((await provider.listModels()).length, 1);
  const words: string[] = [];
  for await (const piece of provider.chat({ messages: [{ role: "user", content: "one two three" }] })) words.push(piece.text);
  assert.deepEqual(words, ["one", "two", "three"]);
  await host.deactivateAll();
});

test("a plugin folder she is developing loads from where it is and reloads when a file changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-plugins-root-"));
  const dev = await mkdtemp(join(tmpdir(), "kesher-plugin-dev-"));
  await mkdir(join(dev, "ui"));
  await writeFile(join(dev, "ui", "a.html"), "<p>a</p>");
  const manifest = (title: string) => JSON.stringify({ id: "my-dev", name: "Dev", version: "0.1.0", kesher: { apiVersion: 1 }, ui: { pages: [{ id: "p", title, file: "ui/a.html" }] } });
  await writeFile(join(dev, "kesher-plugin.json"), manifest("First"));
  const host = new PluginHost(new ProviderRegistry(), KesherConfigSchema.parse({}), root);
  try {
    await host.loadAll([root], [dev]);
    const p = host.list().find((x) => x.manifest.id === "my-dev");
    assert.equal(p?.status, "active");
    assert.equal(p?.dev, true);
    await writeFile(join(dev, "kesher-plugin.json"), manifest("Second"));
    for (let i = 0; i < 40 && host.ui().pages[0]?.title !== "Second"; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(host.ui().pages[0]?.title, "Second");
    // A broken manifest shows as an error instead of disappearing.
    await writeFile(join(dev, "kesher-plugin.json"), "{ not json");
    for (let i = 0; i < 40 && host.list().find((x) => x.dev)?.status !== "error"; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(host.list().find((x) => x.dev)?.status, "error");
  } finally {
    host.stopWatching();
    await host.deactivateAll();
  }
});
