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
  await host.loadAll([root]);
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
  // A provider whose stream crosses the processes.
  const factory = (registry as unknown as { factories: Map<string, { create(c: unknown): { chat(r: unknown): AsyncIterable<{ text: string }>; listModels(): Promise<unknown[]> } }> }).factories.get("boxed-echo")!;
  const provider = factory.create({ id: "e", type: "boxed-echo", name: "E" });
  assert.equal((await provider.listModels()).length, 1);
  const words: string[] = [];
  for await (const piece of provider.chat({ messages: [{ role: "user", content: "one two three" }] })) words.push(piece.text);
  assert.deepEqual(words, ["one", "two", "three"]);
  await host.deactivateAll();
});
