import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
      const mod = (await import(pathToFileURL(join(dir, manifest.main)).href)) as { default?: KesherPlugin };
      if (!mod.default?.activate) throw new Error(`${manifest.main} must default-export definePlugin({...})`);
      const dataDir = join(this.dataRoot, "plugin-data", manifest.id);
      await mkdir(dataDir, { recursive: true });
      await mod.default.activate(this.contextFor(manifest, dataDir));
      this.active.push({ id: manifest.id, plugin: mod.default });
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

  /** Calls every active plugin's `deactivate`. */
  async deactivateAll(): Promise<void> {
    for (const { id, plugin } of this.active.splice(0)) {
      await Promise.resolve(plugin.deactivate?.()).catch((err) => console.warn(`[plugins] ${id} deactivate failed`, err));
    }
  }
}
