import type { AgentMessage, CategoryId, ChatMessage, ChatStreamEvent, ModelInfo, ModelLocation, ToolCall, ToolSpec } from "@kesher/shared";

/**
 * Settings for one provider instance, as stored in the user's config file.
 * The same `type` can appear many times with different settings — e.g. two
 * `openai-compatible` providers, one for LM Studio and one for OpenRouter.
 */
export interface ProviderConfig {
  /** Unique, URL-safe id, used as the first half of model ids. No slashes. */
  id: string;
  /** Which {@link ProviderFactory} builds it, e.g. `openai-compatible`. */
  type: string;
  /** Display name. Defaults to the id. */
  name?: string;
  /** Base URL of the server or API. */
  baseUrl?: string;
  /** API key, if the server needs one. */
  apiKey?: string;
  /** Where its models run. Shown as a badge in the UI. */
  location?: ModelLocation;
  /** Adapter-specific options. Each adapter documents its own keys. */
  options?: Record<string, unknown>;
}

/** What a provider can do. Each `true` entry means the matching method exists. */
export interface ProviderCapabilities {
  /** Streams chat completions through {@link Provider.chat}. */
  chat?: boolean;
  /** Generates images through {@link Provider.generateImage}. */
  image?: boolean;
  /** Runs tool-calling turns through {@link Provider.chatWithTools}. */
  tools?: boolean;
  /** Makes short videos through {@link Provider.generateVideo}. */
  video?: boolean;
}

/** Input to {@link Provider.generateVideo}. */
export interface ProviderVideoRequest {
  /** The provider's own model id. */
  providerModelId: string;
  prompt: string;
  negativePrompt?: string;
  /** Length, in seconds (the provider rounds it to what the model can make). */
  seconds?: number;
  seed?: number;
}

/** Input to {@link Provider.chatWithTools}. */
export interface ProviderToolChatRequest {
  /** The provider's own model id. */
  providerModelId: string;
  /** The whole conversation, including earlier tool calls and results. */
  messages: AgentMessage[];
  /** Tools the model may call. May be empty. */
  tools: ToolSpec[];
  temperature?: number;
  /** Nucleus sampling (0–1). */
  topP?: number;
  /** Texts that end the answer. */
  stop?: string[];
  maxTokens?: number;
}

/** One finished model turn: its text and the tools it wants to call. */
export interface ProviderToolChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Input to {@link Provider.chat}. The model is the provider's own id. */
export interface ProviderChatRequest {
  /** The provider's own model id (the second half of a global model id). */
  providerModelId: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

/** Input to {@link Provider.generateImage}. */
export interface ProviderImageRequest {
  /** The provider's own model id. */
  providerModelId: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  /** Start from this picture (PNG): image to image. */
  initImage?: Uint8Array;
  /** White where to paint, black where to keep (PNG): inpainting. */
  mask?: Uint8Array;
  /** How much to change the starting picture, 0–1. */
  strength?: number;
}

/** A file a provider produced, before the core server stores it as an Asset. */
export interface GeneratedFile {
  data: Uint8Array;
  mimeType: string;
  /** Anything worth keeping with the file: prompt, seed, timings. */
  meta?: Record<string, unknown>;
}

/**
 * A source of models.
 *
 * Implement this to connect a new engine, server or API. Only `listModels`
 * and `checkHealth` are required; implement the generation methods that
 * match the categories your models belong to, and set
 * {@link Provider.capabilities} accordingly.
 *
 * Every method receives an `AbortSignal`. Pass it to `fetch` so the user can
 * cancel a long generation from the UI.
 *
 * @example A minimal provider
 * ```ts
 * class EchoProvider implements Provider {
 *   readonly id = "echo"; readonly name = "Echo"; readonly location = "local";
 *   readonly capabilities = { chat: true };
 *   async checkHealth() { return true; }
 *   async listModels() {
 *     return [{ id: "echo/echo", providerId: "echo", providerModelId: "echo",
 *               name: "Echo", category: "chat", location: "local" }];
 *   }
 *   async *chat(req) {
 *     yield { type: "delta", text: req.messages.at(-1)?.content ?? "" };
 *     yield { type: "done" };
 *   }
 * }
 * ```
 */
export interface Provider {
  /** Same as {@link ProviderConfig.id}. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Where its models run. */
  readonly location: ModelLocation;
  /** Which optional methods this provider implements. */
  readonly capabilities: ProviderCapabilities;

  /** Returns `true` if the server or API answers. Must not throw. */
  checkHealth(signal?: AbortSignal): Promise<boolean>;

  /** Lists the models this provider can serve right now. */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;

  /**
   * Streams a chat completion. Yield `delta` events as text arrives and
   * finish with exactly one `done` (or `error`) event.
   */
  chat?(request: ProviderChatRequest, signal?: AbortSignal): AsyncIterable<ChatStreamEvent>;

  /**
   * Runs one model turn that may call tools. Streams text through `onText`
   * as it arrives and resolves with the full turn. The caller runs the tools
   * and calls again with their results — see `@kesher/agent`.
   */
  chatWithTools?(
    request: ProviderToolChatRequest,
    signal?: AbortSignal,
    onText?: (delta: string) => void,
  ): Promise<ProviderToolChatResult>;

  /** Generates one or more images. */
  generateImage?(request: ProviderImageRequest, signal?: AbortSignal): Promise<GeneratedFile[]>;

  /** Makes a short video clip. */
  generateVideo?(request: ProviderVideoRequest, signal?: AbortSignal): Promise<GeneratedFile[]>;

  /** Turns texts into vectors (embedding models), in the same order. */
  embed?(request: { providerModelId: string; input: string[] }, signal?: AbortSignal): Promise<number[][]>;
}

/**
 * Builds providers of one `type` from their config. Register factories with
 * `ProviderRegistry.registerFactory`; plugins do this through
 * `PluginContext.registerProviderFactory`.
 */
export interface ProviderFactory {
  /** The `type` this factory handles, e.g. `openai-compatible`. */
  type: string;
  /** Human-readable name for the "Add connection" dialog. */
  displayName: string;
  /** Categories its models usually belong to, to filter the dialog. */
  categories: CategoryId[];
  /** Builds a provider. Should not do network I/O; `checkHealth` does that. */
  create(config: ProviderConfig): Provider;
}
