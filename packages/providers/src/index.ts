/**
 * `@kesher/providers` — the {@link Provider} interface and the built-in
 * adapters. Read `provider.ts` first; docs/PROVIDERS.md walks through
 * writing a new adapter.
 *
 * @packageDocumentation
 */
import { anthropicFactory } from "./anthropic.js";
import { comfyUIFactory } from "./comfyui.js";
import { openAICompatibleFactory } from "./openai-compatible.js";
import type { ProviderFactory } from "./provider.js";

export * from "./provider.js";
export * from "./registry.js";
export * from "./presets.js";
export * from "./sse.js";
export { OpenAICompatibleProvider, openAICompatibleFactory, toOpenAIMessages } from "./openai-compatible.js";
export { AnthropicProvider, anthropicFactory, toAnthropicMessages } from "./anthropic.js";
export { parseToolArguments } from "./tool-args.js";
export { ComfyUIProvider, comfyUIFactory, defaultTextToImageWorkflow, type ComfyWorkflow } from "./comfyui.js";

/** The factories the core server registers before loading plugins. */
export const BUILT_IN_FACTORIES: readonly ProviderFactory[] = [openAICompatibleFactory, anthropicFactory, comfyUIFactory];
