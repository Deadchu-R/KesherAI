import type { ProviderRegistry } from "@kesher/providers";
import type { DownloadManager } from "@kesher/downloads";
import type { KesherConfig, DataPaths } from "./config.js";
import type { AssetStore } from "./assets.js";
import type { PluginHost } from "./plugins.js";
import type { LlamaServerManager } from "./llamacpp.js";

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
  /** Present only when `engines.llamaServerPath` is configured. */
  llama?: LlamaServerManager;
  /** Ids of providers found by auto-detection (not saved in the config file). */
  autodetected: Set<string>;
  /** Persists `config` to disk. */
  saveConfig(): Promise<void>;
}
