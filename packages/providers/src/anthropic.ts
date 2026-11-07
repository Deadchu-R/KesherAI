import { makeModelId, type AgentMessage, type ChatStreamEvent, type ModelInfo, type ToolCall } from "@kesher/shared";
import type {
  Provider,
  ProviderChatRequest,
  ProviderConfig,
  ProviderFactory,
  ProviderToolChatRequest,
  ProviderToolChatResult,
} from "./provider.js";
import { parseToolArguments } from "./tool-args.js";
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
  readonly capabilities = { chat: true, tools: true };
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

  /** @inheritDoc */
  async chatWithTools(
    request: ProviderToolChatRequest,
    signal?: AbortSignal,
    onText?: (delta: string) => void,
  ): Promise<ProviderToolChatResult> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const res = await fetchOk(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: this.headers,
      signal,
      body: JSON.stringify({
        model: request.providerModelId,
        max_tokens: request.maxTokens ?? Math.max(this.defaultMaxTokens, 8192),
        temperature: request.temperature,
        ...(system ? { system } : {}),
        messages,
        ...(request.tools.length > 0
          ? { tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }
          : {}),
        stream: true,
      }),
    });
    if (!res.body) throw new Error("Empty response body");

    let text = "";
    const blocks = new Map<number, { id: string; name: string; json: string }>();
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    for await (const data of readSSE(res.body)) {
      const ev = JSON.parse(data) as {
        type: string;
        index?: number;
        content_block?: { type: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string };
        message?: { usage?: { input_tokens?: number } };
        usage?: { output_tokens?: number };
        error?: { message?: string };
      };
      if (ev.type === "error") throw new Error(ev.error?.message ?? "Anthropic API error");
      if (ev.type === "message_start") inputTokens = ev.message?.usage?.input_tokens;
      if (ev.type === "message_delta") outputTokens = ev.usage?.output_tokens ?? outputTokens;
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        blocks.set(ev.index ?? blocks.size, { id: ev.content_block.id ?? "", name: ev.content_block.name ?? "", json: "" });
      }
      if (ev.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta" && ev.delta.text) {
          text += ev.delta.text;
          onText?.(ev.delta.text);
        } else if (ev.delta?.type === "input_json_delta") {
          const block = blocks.get(ev.index ?? -1);
          if (block) block.json += ev.delta.partial_json ?? "";
        }
      }
    }
    const toolCalls: ToolCall[] = [...blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, b]) => ({ id: b.id, name: b.name, arguments: parseToolArguments(b.json) }));
    return { text, toolCalls, usage: { inputTokens, outputTokens } };
  }
}

/** One content block in the Messages API. */
type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

/**
 * Converts provider-neutral messages to the Messages API format: `system`
 * lifted out, tool results sent as `tool_result` blocks in a user turn, and
 * consecutive turns of the same role merged (the API needs alternation).
 *
 * @param messages - Agent messages.
 * @returns The `system` string and the `messages` array.
 */
export function toAnthropicMessages(messages: AgentMessage[]): {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }>;
} {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const out: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const blocks: AnthropicBlock[] = [];
    if (m.role === "tool") {
      blocks.push({ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content || "(no output)" });
    } else {
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
    }
    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  return { system, messages: out };
}

/** Factory for {@link AnthropicProvider}. */
export const anthropicFactory: ProviderFactory = {
  type: "anthropic",
  displayName: "Anthropic (Claude)",
  categories: ["chat"],
  create: (config) => new AnthropicProvider(config),
};
