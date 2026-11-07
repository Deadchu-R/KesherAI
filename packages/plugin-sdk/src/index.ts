/**
 * `@kesher/plugin-sdk` — build KesherAI plugins. Start with {@link definePlugin}
 * and the {@link PluginContext} it receives; docs/PLUGINS.md is the guide.
 *
 * @packageDocumentation
 */
export * from "./manifest.js";
export * from "./context.js";
export * from "./define.js";

// Re-exported so plugins depend on one package only.
export type {
  Provider,
  ProviderConfig,
  ProviderFactory,
  ProviderChatRequest,
  ProviderImageRequest,
  GeneratedFile,
} from "@kesher/providers";
export type { CategoryDefinition, ModelInfo, ChatStreamEvent } from "@kesher/shared";
