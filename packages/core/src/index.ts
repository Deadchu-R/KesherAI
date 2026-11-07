/**
 * `@kesher/core` — the local server every KesherAI client talks to.
 * Start reading at `server.ts`; each file in `routes/` is one area of the
 * HTTP API, documented in docs/API.md.
 *
 * @packageDocumentation
 */
export { createKesherServer, type KesherServer, type KesherServerOptions } from "./server.js";
export { dataPaths, loadConfig, saveConfig, KesherConfigSchema, type KesherConfig, type DataPaths } from "./config.js";
export { AssetStore } from "./assets.js";
export { PluginHost, type LoadedPlugin } from "./plugins.js";
export { LlamaEngine, pickLlamaAssets, findLlamaRelease, extractArchive, type EngineStatus, type LlamaAssets, type PlatformInfo } from "./llamacpp.js";
export { Library, SYNC_SUBFOLDER } from "./library.js";
export { ConversationManager, modelTurnFor, type NewConversation } from "./conversations.js";
export { Updater, type VersionInfo, type UpdateCheck, type UpdateProgress } from "./updates.js";
export { GoogleDrive, GOOGLE_ENDPOINTS, type GoogleConfig, type GoogleEndpoints, type RemoteItem } from "./google.js";
export { DriveSync, type SyncResult } from "./drive-sync.js";
export { isLoopback, isLocalRequest } from "./auth.js";
export type { KesherServices } from "./services.js";
export { CORE_VERSION } from "./routes/system.js";
export * from "./model-scan.js";
export * from "./tunnel.js";
export { allowThroughFirewall, type FirewallResult } from "./firewall.js";
