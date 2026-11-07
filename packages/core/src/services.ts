import type { ProviderRegistry } from "@kesher/providers";
import type { DownloadManager } from "@kesher/downloads";
import type { KesherConfig, DataPaths } from "./config.js";
import type { AssetStore } from "./assets.js";
import type { PluginHost } from "./plugins.js";
import type { LlamaEngine } from "./llamacpp.js";
import type { Library } from "./library.js";
import type { ConversationManager } from "./conversations.js";
import type { Updater } from "./updates.js";

/**
 * Everything a route needs, created once in `createKesherServer` and passed
 * to every route module. Routes never create services themselves, which
 * keeps them easy to test with fakes.
 */
export interface KesherServices {
  config: KesherConfig;
  paths: DataPaths;
  registry: ProviderRegistry;
  assets: AssetStore;
  downloads: DownloadManager;
  plugins: PluginHost;
  /** The built-in llama.cpp engine. */
  engine: LlamaEngine;
  /** Saved projects and conversations. */
  library: Library;
  /** Live conversations. */
  conversations: ConversationManager;
  /** Checks for and applies updates. */
  updater: Updater;
  /** Ids of providers found by auto-detection (not saved in the config file). */
  autodetected: Set<string>;
  /** Persists `config` to disk. */
  saveConfig(): Promise<void>;
  /** Registers (or re-registers) the `llamacpp` provider for the running engine. */
  registerEngineProvider(): void;
}
