/**
 * Checks a plugin before it is published (RESEARCH_LOG "Open source", like Blender's `extension validate` and
 * `comfy node publish`): the manifest, what it asks for, its size, and one real load in a test core.
 *
 * Usage: pnpm plugin:check <plugin folder>
 */
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PluginManifestSchema, PLUGIN_API_VERSION } from "../packages/plugin-sdk/src/index.js";
import { ProviderRegistry } from "../packages/providers/src/index.js";
import { PluginHost } from "../packages/core/src/plugins.js";
import { KesherConfigSchema } from "../packages/core/src/config.js";

const WHAT: Record<string, string> = { network: "reach the internet", filesystem: "read and write files outside its own folders", shell: "run programs on this computer" };

async function size(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = join(dir, e.name);
    n += e.isDirectory() ? await size(p) : (await stat(p)).size;
  }
  return n;
}

const dir = resolve(process.argv[2] ?? ".");
let failed = false;
const bad = (m: string) => { failed = true; console.log(`✗ ${m}`); };
const ok = (m: string) => console.log(`✓ ${m}`);

const raw = await readFile(join(dir, "kesher-plugin.json"), "utf8").catch(() => undefined);
if (raw === undefined) {
  bad(`no kesher-plugin.json in ${dir}`);
  process.exit(1);
}
const parsed = PluginManifestSchema.safeParse(JSON.parse(raw));
if (!parsed.success) {
  bad(`kesher-plugin.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  process.exit(1);
}
const m = parsed.data;
ok(`manifest: ${m.id} ${m.version} (API ${m.kesher.apiVersion})`);
if (m.kesher.apiVersion !== PLUGIN_API_VERSION) bad(`API version ${m.kesher.apiVersion}; this KesherAI loads ${PLUGIN_API_VERSION}`);
if (!m.description) console.log("! no description: the Community screen shows it under the name");
for (const p of m.permissions ?? []) console.log(`! asks to ${WHAT[p] ?? p} ("${p}"): users see this before turning it on`);
const bytes = await size(dir);
if (bytes > 50 * 1024 * 1024) bad(`${(bytes / 1048576).toFixed(1)} MB without node_modules: keep it under 50 MB`);
else ok(`size ${(bytes / 1048576).toFixed(2)} MB`);

// One real load, in a test core with its own data folder.
const data = await mkdtemp(join(tmpdir(), "kesher-plugin-check-"));
const config = KesherConfigSchema.parse({ plugins: { [m.id]: { enabled: true } } });
const host = new PluginHost(new ProviderRegistry(), config, data);
try {
  await host.loadAll([], [dir]);
  const p = host.list().find((x) => x.manifest.id === m.id);
  if (p?.status === "active") ok(`loads: ${[...host.tools.values()].filter((t) => t.pluginId === m.id).length} tools, ${host.ui().pages.length} pages`);
  else bad(`does not load: ${p?.error ?? p?.status ?? "not found"}`);
} finally {
  host.stopWatching();
  await host.deactivateAll();
  await rm(data, { recursive: true, force: true });
}
console.log(failed ? "\nNot ready to publish." : "\nReady: push it to GitHub with the topic kesherai-plugin.");
process.exit(failed ? 1 : 0);
