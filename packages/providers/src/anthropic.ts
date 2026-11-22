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
 * - `promptCache` (boolean, default true): mark prompt-cache breakpoints (see {@link addCacheBreakpoints}),
 *   so repeated turns read the unchanged prefix at a tenth of the input price.
 */
export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly location = "cloud" as const;
  readonly capabilities = { chat: true, tools: true };
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultMaxTokens: number;
  private readonly promptCache: boolean;

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
    this.promptCache = config.options?.promptCache !== false;
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

    const usage = new UsageReader();
    for await (const data of readSSE(res.body)) {
      const event = JSON.parse(data) as {
        type: string;
        delta?: { type?: string; text?: string };
        message?: { usage?: AnthropicUsage };
        usage?: AnthropicUsage;
        error?: { message?: string };
      };
      usage.read(event);
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        yield { type: "delta", text: event.delta.text };
      } else if (event.type === "error") {
        yield { type: "error", message: event.error?.message ?? "Anthropic API error" };
        return;
      }
    }
    const { cacheWriteTokens: _write, ...done } = usage.result();
    yield { type: "done", usage: done };
  }

  /** @inheritDoc */
  async chatWithTools(
    request: ProviderToolChatRequest,
    signal?: AbortSignal,
    onText?: (delta: string) => void,
  ): Promise<ProviderToolChatResult> {
    const converted = toAnthropicMessages(request.messages);
    const plainTools = request.tools.map((t): AnthropicTool => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    const { system, messages, tools } = this.promptCache
      ? addCacheBreakpoints(converted.systemParts, converted.messages, plainTools)
      : { system: converted.system, messages: converted.messages, tools: plainTools };
    const res = await fetchOk(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: this.headers,
      signal,
      body: JSON.stringify({
        model: request.providerModelId,
        max_tokens: request.maxTokens ?? Math.max(this.defaultMaxTokens, 8192),
        temperature: request.temperature,
        // Claude takes temperature or top_p, not both; stop texts are its stop_sequences.
        ...("stop" in request && request.stop?.length ? { stop_sequences: request.stop } : {}),
        ...(system.length > 0 ? { system } : {}),
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        stream: true,
      }),
    });
    if (!res.body) throw new Error("Empty response body");

    let text = "";
    const blocks = new Map<number, { id: string; name: string; json: string }>();
    const usage = new UsageReader();
    for await (const data of readSSE(res.body)) {
      const ev = JSON.parse(data) as {
        type: string;
        index?: number;
        content_block?: { type: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string };
        message?: { usage?: AnthropicUsage };
        usage?: AnthropicUsage;
        error?: { message?: string };
      };
      if (ev.type === "error") throw new Error(ev.error?.message ?? "Anthropic API error");
      usage.read(ev);
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
    return { text, toolCalls, usage: usage.result() };
  }
}

/** The `usage` object of `message_start` / `message_delta` events. */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Sums the token counts of one streamed answer. Anthropic's `input_tokens` leaves out the cached parts, so the
 * result's `inputTokens` is the whole prompt (uncached + read + written) and `cachedTokens` / `cacheWriteTokens`
 * say how much of it was read from or written to the prompt cache, the same shape the other providers report.
 */
class UsageReader {
  private input?: number;
  private output?: number;
  private read_?: number;
  private write?: number;

  /** Takes the counts from one event (`message_start` carries the prompt's, `message_delta` the running output). */
  read(ev: { type: string; message?: { usage?: AnthropicUsage }; usage?: AnthropicUsage }): void {
    const u = ev.type === "message_start" ? ev.message?.usage : ev.type === "message_delta" ? ev.usage : undefined;
    if (!u) return;
    if (typeof u.input_tokens === "number") this.input = u.input_tokens;
    if (typeof u.output_tokens === "number") this.output = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number") this.read_ = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") this.write = u.cache_creation_input_tokens;
  }

  /** The counts so far; cache fields only when the API sent them. */
  result(): { inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheWriteTokens?: number } {
    const cacheKnown = this.read_ !== undefined || this.write !== undefined;
    const inputTokens = this.input === undefined ? undefined : this.input + (this.read_ ?? 0) + (this.write ?? 0);
    return {
      inputTokens,
      outputTokens: this.output,
      ...(cacheKnown ? { cachedTokens: this.read_ ?? 0, cacheWriteTokens: this.write ?? 0 } : {}),
    };
  }
}

/** A tool definition as the Messages API takes it. */
type AnthropicTool = { name: string; description: string; input_schema: unknown; cache_control?: CacheControl };
/** Marks the end of a cached prefix (5 minutes, refreshed on every hit). */
type CacheControl = { type: "ephemeral" };
const EPHEMERAL: CacheControl = { type: "ephemeral" };
/** The Messages API takes at most four cache breakpoints per request. */
const MAX_BREAKPOINTS = 4;

/**
 * Adds prompt-cache breakpoints (`cache_control`) so the unchanged start of the prompt is read from Anthropic's
 * cache on the next turn. The prefix order is tools, then system, then messages; the breakpoints, at most four:
 * 1. the last tool (the tool list stays the same within a chat),
 * 2. the first system block (the static instructions; later system blocks may change without losing 1 and 2),
 * 3. the last user turn (written now, read by the next call),
 * 4. the second-to-last user turn (read now: it is where the previous call wrote its cache).
 * Prompts shorter than the model's minimum are simply not cached; nothing fails.
 *
 * @param systemParts - The system messages' texts, in order.
 * @param messages - Converted messages (from {@link toAnthropicMessages}); not changed.
 * @param tools - Tool definitions; not changed.
 * @returns Copies with the breakpoints: `system` as text blocks, `messages`, and `tools`.
 */
export function addCacheBreakpoints(
  systemParts: string[],
  messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }>,
  tools: AnthropicTool[],
): {
  system: Array<{ type: "text"; text: string; cache_control?: CacheControl }>;
  messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }>;
  tools: AnthropicTool[];
} {
  let left = MAX_BREAKPOINTS;
  const lastTool = tools.length - 1;
  const outTools = tools.map((t, i) => (i === lastTool && left-- > 0 ? { ...t, cache_control: EPHEMERAL } : t));
  const system = systemParts
    .filter((text) => text.length > 0)
    .map((text, i) => (i === 0 && left-- > 0 ? { type: "text" as const, text, cache_control: EPHEMERAL } : { type: "text" as const, text }));
  const userTurns = messages.flatMap((m, i) => (m.role === "user" ? [i] : [])).slice(-2).reverse();
  const marked = new Set<number>();
  for (const i of userTurns) if (left-- > 0) marked.add(i);
  const outMessages = messages.map((m, i) => {
    if (!marked.has(i) || m.content.length === 0) return m;
    const content = m.content.slice();
    content[content.length - 1] = { ...content[content.length - 1]!, cache_control: EPHEMERAL };
    return { ...m, content };
  });
  return { system, messages: outMessages, tools: outTools };
}

/** One content block in the Messages API (any of them may carry a cache breakpoint). */
type AnthropicBlock = (
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | Array<{ type: "text"; text: string } | AnthropicImage> }
  | AnthropicImage
) & { cache_control?: CacheControl };
type AnthropicImage = { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/**
 * Converts provider-neutral messages to the Messages API format: `system`
 * lifted out, tool results sent as `tool_result` blocks in a user turn, and
 * consecutive turns of the same role merged (the API needs alternation).
 *
 * @param messages - Agent messages.
 * @returns The `system` string, the same texts one per system message (`systemParts`, for cache blocks), and
 *   the `messages` array.
 */
export function toAnthropicMessages(messages: AgentMessage[]): {
  system: string;
  systemParts: string[];
  messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }>;
} {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const system = systemParts.join("\n\n");
  const out: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const blocks: AnthropicBlock[] = [];
    const pictures: AnthropicImage[] = (m.images ?? []).map((img) => ({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } }));
    if (m.role === "tool") {
      const text = m.content || "(no output)";
      blocks.push({ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: pictures.length ? [{ type: "text", text }, ...pictures] : text });
    } else {
      if (m.content) blocks.push({ type: "text", text: m.content });
      blocks.push(...pictures);
      for (const tc of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
    }
    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  return { system, systemParts, messages: out };
}

/** Factory for {@link AnthropicProvider}. */
export const anthropicFactory: ProviderFactory = {
  type: "anthropic",
  displayName: "Anthropic (Claude)",
  categories: ["chat"],
  create: (config) => new AnthropicProvider(config),
};
