import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { CategoryDefinition } from "@kesher/shared";
import type { ProviderRegistry } from "@kesher/providers";
import {
  PLUGIN_API_VERSION,
  PluginManifestSchema,
  type KesherPlugin,
  type KesherTool,
  type PluginContext,
  type PluginManifest,
  type PluginProgram,
} from "@kesher/plugin-sdk";
import type { KesherConfig } from "./config.js";

/** A plugin the host found, whether or not it loaded. */
export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  status: "active" | "disabled" | "error";
  error?: string;
}

/**
 * Finds, validates and activates plugins.
 *
 * A plugin is any folder with a `kesher-plugin.json` inside one of the
 * plugin roots. Plugins currently run inside the core server's process;
 * running each in its own process with only the permissions it declared is
 * on the roadmap (see docs/PLUGINS.md → Security).
 */
export class PluginHost {
  /** Tools registered by plugins, by name. */
  readonly tools = new Map<string, KesherTool & { pluginId: string }>();
  /** Categories registered by plugins. */
  readonly categories: CategoryDefinition[] = [];
  private readonly plugins: LoadedPlugin[] = [];
  private readonly active: Array<{ id: string; plugin: KesherPlugin }> = [];
  private roots: string[] = [];

  /**
   * @param registry - Where plugin provider factories go.
   * @param config - App config, for per-plugin settings and enable flags.
   * @param dataRoot - Plugins get `<dataRoot>/plugin-data/<id>` as their data folder.
   */
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly config: KesherConfig,
    private readonly dataRoot: string,
  ) {}

  /** @returns Every plugin found, with its status. */
  list(): LoadedPlugin[] {
    return [...this.plugins];
  }

  /**
   * Loads every plugin in the given roots. A broken plugin is reported in
   * {@link list} and never stops the others from loading.
   *
   * @param roots - Folders whose sub-folders are plugins.
   */
  async loadAll(roots: string[]): Promise<void> {
    this.roots = roots;
    for (const root of roots) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) await this.loadOne(resolve(root, entry.name));
      }
    }
  }

  private async loadOne(dir: string): Promise<void> {
    let manifest: PluginManifest;
    try {
      const raw = await readFile(join(dir, "kesher-plugin.json"), "utf8");
      manifest = PluginManifestSchema.parse(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // not a plugin folder
      console.warn(`[plugins] invalid manifest in ${dir}: ${(err as Error).message}`);
      return;
    }

    const record: LoadedPlugin = { manifest, dir, status: "disabled" };
    this.plugins.push(record);
    if (this.plugins.filter((p) => p.manifest.id === manifest.id).length > 1) {
      record.status = "error";
      record.error = `Another plugin already uses the id "${manifest.id}"`;
      return;
    }
    if (this.config.plugins[manifest.id]?.enabled === false) return;
    if (manifest.kesher.apiVersion !== PLUGIN_API_VERSION) {
      record.status = "error";
      record.error = `Built for plugin API v${manifest.kesher.apiVersion}, this app has v${PLUGIN_API_VERSION}`;
      return;
    }

    try {
      const dataDir = join(this.dataRoot, "plugin-data", manifest.id);
      await mkdir(dataDir, { recursive: true });
      // A plugin without code (only `ui` and `programs`) is a mod; older manifests defaulted `main` to dist/index.js.
      const main = manifest.main ?? (existsSync(join(dir, "dist", "index.js")) ? "dist/index.js" : undefined);
      if (main) {
        const mod = (await import(pathToFileURL(join(dir, main)).href)) as { default?: KesherPlugin };
        if (!mod.default?.activate) throw new Error(`${main} must default-export definePlugin({...})`);
        await mod.default.activate(this.contextFor(manifest, dataDir));
        this.active.push({ id: manifest.id, plugin: mod.default });
      }
      for (const program of manifest.programs) this.registerProgram(manifest, program, dataDir);
      record.status = "active";
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      console.warn(`[plugins] ${manifest.id} failed to activate: ${record.error}`);
    }
  }

  private contextFor(manifest: PluginManifest, dataDir: string): PluginContext {
    const prefix = `[plugin:${manifest.id}]`;
    return {
      pluginId: manifest.id,
      dataDir,
      settings: this.config.plugins[manifest.id]?.settings ?? {},
      log: {
        info: (m, d) => console.log(prefix, m, d ?? ""),
        warn: (m, d) => console.warn(prefix, m, d ?? ""),
        error: (m, d) => console.error(prefix, m, d ?? ""),
      },
      registerProviderFactory: (factory) => this.registry.registerFactory(factory),
      registerCategory: (category) => {
        if (!this.categories.some((c) => c.id === category.id)) this.categories.push(category);
      },
      registerTool: (tool) => {
        if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
        this.tools.set(tool.name, { ...tool, pluginId: manifest.id });
      },
    };
  }

  /**
   * Turns a declared program into a tool. It always needs the user's
   * approval (plugin tools are "exec" risk), runs without a shell, and
   * either waits for it (with a time limit) or just starts it (an app with
   * a window, `timeoutSeconds: 0`).
   */
  private registerProgram(manifest: PluginManifest, program: PluginProgram, dataDir: string): void {
    const name = `${manifest.id.replace(/-/g, "_")}_${program.id}`;
    if (this.tools.has(name)) return;
    this.tools.set(name, {
      pluginId: manifest.id,
      name,
      description: `${program.description} (Starts ${program.name} on the user's computer; they approve first.)`,
      inputSchema: {
        type: "object",
        properties: {
          ...(program.extraArgs ? { args: { type: "array", items: { type: "string" }, description: "Extra command-line arguments." } } : {}),
          cwd: { type: "string", description: "Folder to run in (absolute). Default: the plugin's data folder." },
        },
      },
      run: (input, signal) =>
        new Promise((resolveRun, reject) => {
          const extra = program.extraArgs && Array.isArray(input.args) ? input.args.map(String) : [];
          const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : dataDir;
          const detached = program.timeoutSeconds === 0;
          const child = spawn(program.command, [...program.args, ...extra], { cwd, windowsHide: !detached, detached, stdio: detached ? "ignore" : "pipe" });
          child.on("error", (err) => reject(new Error(`Could not start ${program.name}: ${err.message}`)));
          if (detached) {
            child.unref();
            child.on("spawn", () => resolveRun(`${program.name} started.`));
            return;
          }
          let out = "";
          child.stdout?.on("data", (b: Buffer) => (out = (out + b.toString()).slice(-20_000)));
          child.stderr?.on("data", (b: Buffer) => (out = (out + b.toString()).slice(-20_000)));
          const timer = setTimeout(() => child.kill(), program.timeoutSeconds * 1000);
          signal.addEventListener("abort", () => child.kill(), { once: true });
          child.on("close", (code) => {
            clearTimeout(timer);
            resolveRun(`${out.trim() || "(no output)"}\n\n[${program.name} exited with code ${code}]`);
          });
        }),
    });
  }

  /**
   * Everything active plugins add to the interface.
   *
   * @returns Pages, panels, styles and composer buttons, each with its plugin id.
   */
  ui(): {
    pages: Array<{ pluginId: string; id: string; title: string; icon?: string; file: string; layout: "page" | "app"; uses: string[] }>;
    panels: Array<{ pluginId: string; id: string; title: string; file: string; uses: string[] }>;
    styles: Array<{ pluginId: string; file: string }>;
    composerActions: Array<{ pluginId: string; id: string; label: string; prompt: string }>;
  } {
    const active = this.plugins.filter((p) => p.status === "active" && p.manifest.ui);
    const each = <T>(pick: (p: LoadedPlugin) => T[]) => active.flatMap((p) => pick(p).map((x) => ({ pluginId: p.manifest.id, ...x })));
    return {
      pages: each((p) => p.manifest.ui!.pages.map((x) => ({ ...x, uses: p.manifest.uses }))),
      panels: each((p) => p.manifest.ui!.panels.map((x) => ({ ...x, uses: p.manifest.uses }))),
      styles: each((p) => p.manifest.ui!.styles.map((file) => ({ file }))),
      composerActions: each((p) => p.manifest.ui!.composerActions),
    };
  }

  /**
   * A file inside a plugin's folder, for its pages and styles.
   *
   * @param id - Plugin id.
   * @param rel - Path inside the folder.
   * @returns The absolute path, or `undefined` if the plugin is unknown or the path leaves its folder.
   */
  fileOf(id: string, rel: string): string | undefined {
    const p = this.plugins.find((x) => x.manifest.id === id && x.status === "active");
    if (!p) return undefined;
    const full = resolve(p.dir, rel);
    return full.startsWith(resolve(p.dir) + sep) ? full : undefined;
  }

  /**
   * Installs a plugin from a Git repository (GitHub, GitLab, …) into the
   * user's plugin folder and loads it. The user sees its permissions in the
   * list and can turn it off.
   *
   * @param source - `https://…` Git URL, or `owner/repo` for GitHub.
   * @param into - The user's plugin folder.
   * @param beforeLoad - Runs before it loads (the server marks it off until the user turns it on).
   * @returns The plugin's id.
   */
  async install(source: string, into: string, beforeLoad?: (id: string) => Promise<void>): Promise<string> {
    const url = /^[\w.-]+\/[\w.-]+$/.test(source) ? `https://github.com/${source}.git` : source;
    if (!/^https:\/\/[\w.-]+\/[\w./-]+$/.test(url)) throw new Error("Give an https Git address, or owner/repo for GitHub.");
    await mkdir(into, { recursive: true });
    const folder = join(into, `install-${Date.now()}`);
    await new Promise<void>((ok, fail) => {
      const git = spawn("git", ["clone", "--depth", "1", url, folder], { windowsHide: true });
      let err = "";
      git.stderr.on("data", (b: Buffer) => (err += b.toString()));
      git.on("error", () => fail(new Error("Git is not installed. Install it (Settings → Tools, or the install_tool tool) and try again.")));
      git.on("close", (code) => (code === 0 ? ok() : fail(new Error(`git clone failed: ${err.trim().split("\n").pop()}`))));
    });
    let manifest: PluginManifest;
    try {
      manifest = PluginManifestSchema.parse(JSON.parse(await readFile(join(folder, "kesher-plugin.json"), "utf8")));
    } catch (err) {
      await rm(folder, { recursive: true, force: true });
      throw new Error(`That repository is not a KesherAI plugin (kesher-plugin.json is missing or invalid): ${(err as Error).message}`);
    }
    const final = join(into, manifest.id);
    if (this.plugins.some((p) => p.manifest.id === manifest.id) || existsSync(final)) {
      await rm(folder, { recursive: true, force: true });
      throw new Error(`A plugin with the id "${manifest.id}" is already installed.`);
    }
    const { rename } = await import("node:fs/promises");
    await rename(folder, final);
    await beforeLoad?.(manifest.id);
    await this.loadOne(final);
    return manifest.id;
  }

  /**
   * Removes a plugin the user installed (only from their plugin folder).
   *
   * @param id - Plugin id.
   * @param userDir - The user's plugin folder.
   */
  async uninstall(id: string, userDir: string): Promise<void> {
    const p = this.plugins.find((x) => x.manifest.id === id);
    if (!p) throw new Error("No such plugin.");
    if (!resolve(p.dir).startsWith(resolve(userDir) + sep)) throw new Error("This plugin ships with KesherAI and cannot be removed; turn it off instead.");
    await this.reload(async () => rm(p.dir, { recursive: true, force: true }));
  }

  /**
   * Unloads every plugin and loads them again (after enabling, disabling or removing one).
   *
   * @param between - Runs while nothing is loaded.
   */
  async reload(between?: () => Promise<unknown>): Promise<void> {
    await this.deactivateAll();
    this.tools.clear();
    this.categories.length = 0;
    this.plugins.length = 0;
    await between?.();
    await this.loadAll(this.roots);
  }

  /** Calls every active plugin's `deactivate`. */
  async deactivateAll(): Promise<void> {
    for (const { id, plugin } of this.active.splice(0)) {
      await Promise.resolve(plugin.deactivate?.()).catch((err) => console.warn(`[plugins] ${id} deactivate failed`, err));
    }
  }
}
