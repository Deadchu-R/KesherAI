import type { AgentMessage, JobProgress, CategoryId, ChatMessage, ChatStreamEvent, ModelInfo, ModelLocation, ThinkingLevel, ToolCall, ToolSpec } from "@kesher/shared";

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
  /** Live progress while it runs (steps, preview frames); providers that cannot tell leave it uncalled. */
  onProgress?: (p: JobProgress) => void;
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
  /** llama.cpp only (sampling-presets.ts): keep the K likeliest tokens. */
  topK?: number;
  /** llama.cpp only: drop tokens below this share of the likeliest one (0 turns llama's own 0.05 off). */
  minP?: number;
  /** Punishes tokens already used (OpenAI-style field; llama.cpp honours it). */
  presencePenalty?: number;
  /** Texts that end the answer. */
  stop?: string[];
  maxTokens?: number;
  /** llama.cpp only: texts whose tokens get this bias (e.g. other alphabets made unlikely in a Hebrew answer). */
  logitBias?: Array<[string, number]>;
  /**
   * llama.cpp only: who is asking, so each kind keeps its own slot (and its cached prompt) when the server has
   * enough slots. Unset counts as `other`. Other providers ignore it.
   */
  slotKind?: SlotKind;
  /** Local reasoning models: how much to think (shared thinking.ts); unset leaves the model's default. */
  thinking?: ThinkingLevel;
  /**
   * llama.cpp only: write one call of the tool `name` whose arguments must fit `schema` (sent as `json_schema`, so the
   * server's grammar only lets valid JSON out). The turn is sent without tools and comes back as that one tool call.
   * Other providers ignore it (and answer as usual).
   */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

/** Which agent asks: the chat's main model, a helper (sub-agent), or anything else (router, teammate, side jobs). */
export type SlotKind = "main" | "helper" | "other";

/** Tokens one model call used, as the provider reported them. */
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Of `inputTokens`, how many came from the server's prompt cache (llama.cpp `timings.cache_n`, OpenAI `cached_tokens`). */
  cachedTokens?: number;
  /** Of `inputTokens`, how many were written to the prompt cache this call (Anthropic `cache_creation_input_tokens`). */
  cacheWriteTokens?: number;
}

/** One finished model turn: its text and the tools it wants to call. */
export interface ProviderToolChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage?: ProviderUsage;
  /** The server stopped at the token limit (`finish_reason: "length"`): the text or a tool call in it is cut off. */
  truncated?: boolean;
}

/** Input to {@link Provider.chat}. The model is the provider's own id. */
export interface ProviderChatRequest {
  /** The provider's own model id (the second half of a global model id). */
  providerModelId: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Local reasoning models: how much to think; `off` asks for a short direct answer. Unset leaves the model's default. */
  thinking?: ThinkingLevel;
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
  /** Live progress while it runs (steps, preview frames); providers that cannot tell leave it uncalled. */
  onProgress?: (p: JobProgress) => void;
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

  /**
   * Searches the web with the provider's own search (Gemini's Google Search grounding; gemini-grounding.ts). Only
   * research uses it, as its last search backend. Throws a plain reason (free limit, billing needed) on failure.
   */
  webSearch?(query: string, signal?: AbortSignal): Promise<Array<{ title: string; url: string; snippet: string }>>;
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
