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
