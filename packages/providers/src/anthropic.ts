import { makeModelId, type ChatStreamEvent, type ModelInfo } from "@kesher/shared";
import type { Provider, ProviderChatRequest, ProviderConfig, ProviderFactory } from "./provider.js";
import { fetchOk, readSSE } from "./sse.js";

const API_VERSION = "2023-06-01";

/**
 * Provider for Anthropic's Messages API (Claude models).
 *
 * `system` messages are lifted into the API's top-level `system` field,
 * because the Messages API does not accept them inside `messages`.
 *
 * Options (`ProviderConfig.options`):
 * - `defaultMaxTokens` (number, default 4096): used when the request sets none,
 *   since the Messages API requires `max_tokens`.
 */
export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly location = "cloud" as const;
  readonly capabilities = { chat: true };
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultMaxTokens: number;

  /**
   * @param config - Needs `apiKey`. `baseUrl` defaults to `https://api.anthropic.com/v1`.
   * @throws Error if `apiKey` is missing.
   */
  constructor(config: ProviderConfig) {
    if (!config.apiKey) throw new Error(`Provider "${config.id}" needs an apiKey`);
    this.id = config.id;
    this.name = config.name ?? "Anthropic";
    this.baseUrl = (config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.defaultMaxTokens = Number(config.options?.defaultMaxTokens ?? 4096);
  }

  private get headers(): Record<string, string> {
    return { "x-api-key": this.apiKey, "anthropic-version": API_VERSION, "content-type": "application/json" };
  }

  /** @inheritDoc */
  async checkHealth(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models?limit=1`, { headers: this.headers, signal: signal ?? AbortSignal.timeout(4000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** @inheritDoc */
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await fetchOk(`${this.baseUrl}/models?limit=100`, { headers: this.headers, signal });
    const json = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
    return (json.data ?? []).map((m) => ({
      id: makeModelId(this.id, m.id),
      providerId: this.id,
      providerModelId: m.id,
      name: m.display_name ?? m.id,
      category: "chat",
      location: "cloud" as const,
    }));
  }

  /** @inheritDoc */
  async *chat(request: ProviderChatRequest, signal?: AbortSignal): AsyncIterable<ChatStreamEvent> {
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const messages = request.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await fetchOk(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: this.headers,
      signal,
      body: JSON.stringify({
        model: request.providerModelId,
        max_tokens: request.maxTokens ?? this.defaultMaxTokens,
        temperature: request.temperature,
        ...(system ? { system } : {}),
        messages,
        stream: true,
      }),
    });
    if (!res.body) throw new Error("Empty response body");

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    for await (const data of readSSE(res.body)) {
      const event = JSON.parse(data) as {
        type: string;
        delta?: { type?: string; text?: string };
        message?: { usage?: { input_tokens?: number } };
        usage?: { output_tokens?: number };
        error?: { message?: string };
      };
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        yield { type: "delta", text: event.delta.text };
      } else if (event.type === "message_start") {
        inputTokens = event.message?.usage?.input_tokens;
      } else if (event.type === "message_delta") {
        outputTokens = event.usage?.output_tokens ?? outputTokens;
      } else if (event.type === "error") {
        yield { type: "error", message: event.error?.message ?? "Anthropic API error" };
        return;
      }
    }
    yield { type: "done", usage: { inputTokens, outputTokens } };
  }
}

/** Factory for {@link AnthropicProvider}. */
export const anthropicFactory: ProviderFactory = {
  type: "anthropic",
  displayName: "Anthropic (Claude)",
  categories: ["chat"],
  create: (config) => new AnthropicProvider(config),
};
