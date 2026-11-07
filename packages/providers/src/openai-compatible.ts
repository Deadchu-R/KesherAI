import { makeModelId, type ChatStreamEvent, type ModelInfo, type ModelLocation } from "@kesher/shared";
import type { Provider, ProviderChatRequest, ProviderConfig, ProviderFactory } from "./provider.js";
import { fetchOk, readSSE } from "./sse.js";

/**
 * Provider for any server that speaks the OpenAI Chat Completions API.
 *
 * This one adapter covers llama.cpp's `llama-server`, LM Studio, Ollama
 * (through its `/v1` endpoint), vLLM, LocalAI, OpenAI, OpenRouter, Groq and
 * many more — see `presets.ts` for ready-made configs.
 *
 * Options (`ProviderConfig.options`):
 * - `headers` (`Record<string, string>`): extra headers sent with every request.
 *
 * Models whose id contains `embed` are listed in the `embedding` category;
 * everything else in `chat`.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly location: ModelLocation;
  readonly capabilities = { chat: true };
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  /**
   * @param config - Needs `baseUrl` ending in `/v1` (or the API's equivalent).
   * @throws Error if `baseUrl` is missing.
   */
  constructor(config: ProviderConfig) {
    if (!config.baseUrl) throw new Error(`Provider "${config.id}" needs a baseUrl`);
    this.id = config.id;
    this.name = config.name ?? config.id;
    this.location = config.location ?? "server";
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.headers = {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      ...((config.options?.headers as Record<string, string> | undefined) ?? {}),
    };
  }

  /** @inheritDoc */
  async checkHealth(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers, signal: signal ?? AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** @inheritDoc */
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await fetchOk(`${this.baseUrl}/models`, { headers: this.headers, signal });
    const json = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> };
    return (json.data ?? []).map((m) => ({
      id: makeModelId(this.id, m.id),
      providerId: this.id,
      providerModelId: m.id,
      name: m.id,
      category: /embed/i.test(m.id) ? "embedding" : "chat",
      location: this.location,
      ...(m.owned_by ? { details: { ownedBy: m.owned_by } } : {}),
    }));
  }

  /** @inheritDoc */
  async *chat(request: ProviderChatRequest, signal?: AbortSignal): AsyncIterable<ChatStreamEvent> {
    const res = await fetchOk(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers,
      signal,
      body: JSON.stringify({
        model: request.providerModelId,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        })),
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.body) throw new Error("Empty response body");

    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    for await (const data of readSSE(res.body)) {
      if (data === "[DONE]") break;
      const chunk = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) yield { type: "delta", text };
      if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
    }
    yield { type: "done", ...(usage ? { usage } : {}) };
  }
}

/** Factory for {@link OpenAICompatibleProvider}. */
export const openAICompatibleFactory: ProviderFactory = {
  type: "openai-compatible",
  displayName: "OpenAI-compatible server or API",
  categories: ["chat", "embedding"],
  create: (config) => new OpenAICompatibleProvider(config),
};
