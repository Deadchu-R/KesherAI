import { textToolCalls } from "./text-tool-calls.js";
import { makeModelId, thinkingFields, type AgentMessage, type ChatStreamEvent, type ModelInfo, type ModelLocation, type ToolCall } from "@kesher/shared";
import type {
  Provider,
  ProviderChatRequest,
  ProviderConfig,
  ProviderFactory,
  ProviderToolChatRequest,
  ProviderToolChatResult,
  ProviderUsage,
  SlotKind,
} from "./provider.js";
import { parseToolArguments } from "./tool-args.js";
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
 * - `llamaCpp` (`{ slots?: () => number; parallelChats?: () => number }`): the server is llama.cpp's `llama-server`
 *   (KesherAI's own engine). Requests then ask it to keep the prompt cache (`cache_prompt`) and, when it has enough
 *   slots, pin each agent kind to its own slot (`id_slot`; see {@link llamaCppFields}). Never set for other servers:
 *   they may reject unknown fields.
 *
 * Models whose id contains `embed` are listed in the `embedding` category;
 * everything else in `chat`.
 *
 * Tool calling uses the standard `tools` / `tool_calls` fields. llama.cpp
 * needs `--jinja` for it (Kesher's managed llama-server always sets it).
 */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly location: ModelLocation;
  readonly capabilities = { chat: true, tools: true };
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  /** Whether chats carry `x-opencode-session` (OpenCode's own endpoints). */
  private readonly sessionHeader: boolean;
  /** How long to keep trying while the server cannot be reached (the main KesherAI restarting for an update). */
  private readonly waitMs: number;
  /** Set for llama.cpp's server: how many slots it has now (see {@link llamaCppFields}). */
  private readonly llamaCpp?: { slots?: () => number; parallelChats?: () => number };

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
    this.waitMs = Number(config.options?.waitForServerMs ?? 0) || 0;
    const llama = config.options?.llamaCpp;
    if (llama) this.llamaCpp = typeof llama === "object" ? (llama as { slots?: () => number; parallelChats?: () => number }) : {};
    // OpenCode Go refuses chats without a stable per-conversation id ("MissingSessionID", 2026-11-22) and asks clients
    // to name themselves instead of a generic HTTP library (opencode.ai/docs/console/go, "Where can I use it").
    this.sessionHeader = /(^|\.)opencode\.ai$/i.test(hostOf(this.baseUrl));
    this.headers = {
      "content-type": "application/json",
      ...(this.sessionHeader ? { "user-agent": "KesherAI/1.0" } : {}),
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      ...((config.options?.headers as Record<string, string> | undefined) ?? {}),
    };
  }

  /**
   * The headers for one chat request: the shared ones, plus `x-opencode-session` for OpenCode's endpoints. Requests carry
   * no conversation id, so the id is a hash of the conversation's start (its first two messages), which stays the same
   * for every turn of one conversation and differs between conversations.
   */
  private chatHeaders(messages: ReadonlyArray<{ role?: unknown; content?: unknown }>): Record<string, string> {
    if (!this.sessionHeader) return this.headers;
    return { ...this.headers, "x-opencode-session": conversationKey(messages) };
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
  async embed(request: { providerModelId: string; input: string[] }, signal?: AbortSignal): Promise<number[][]> {
    const res = await fetchOk(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: this.headers,
      signal,
      body: JSON.stringify({ model: request.providerModelId, input: request.input }),
    });
    const json = (await res.json()) as { data?: Array<{ index?: number; embedding: number[] }> };
    const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== request.input.length) throw new Error(`The embedding model returned ${data.length} vectors for ${request.input.length} texts.`);
    return data.map((d) => d.embedding);
  }

  /** @inheritDoc */
  async *chat(request: ProviderChatRequest, signal?: AbortSignal): AsyncIterable<ChatStreamEvent> {
    const res = await fetchOk(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.chatHeaders(request.messages),
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
        ...(this.llamaCpp ? llamaCppFields(undefined, this.llamaCpp.slots?.() ?? 0, this.llamaCpp.parallelChats?.() ?? 1) : {}),
      }),
    });
    if (!res.body) throw new Error("Empty response body");

    let usage: ProviderUsage | undefined;
    for await (const data of readSSE(res.body)) {
      if (data === "[DONE]") break;
      const chunk = JSON.parse(data) as UsageReport & { choices?: Array<{ delta?: { content?: string | null } }> };
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) yield { type: "delta", text };
      usage = readUsage(chunk, usage);
    }
    yield { type: "done", ...(usage ? { usage } : {}) };
  }

  /** @inheritDoc */
  async chatWithTools(
    request: ProviderToolChatRequest,
    signal?: AbortSignal,
    onText?: (delta: string) => void,
  ): Promise<ProviderToolChatResult> {
    try {
      return await this.toolTurn(request, signal, onText);
    } catch (err) {
      // A model without vision rejects the whole turn when a message carries a picture (e.g. a screenshot a
      // tool took): send it again with the pictures left out, so the work goes on.
      const hasImages = request.messages.some((m) => m.images?.length);
      if (!hasImages || !/image|vision|multimodal/i.test((err as Error).message) || signal?.aborted) throw err;
      const messages = request.messages.map((m) => (m.images?.length ? { ...m, images: undefined, content: `${m.content}\n(A picture was attached here, but this model cannot see pictures. Say so, and that on the Models page the 👁 button beside a downloaded model adds vision when its repository has it, or that a model with vision can be chosen.)` } : m));
      return this.toolTurn({ ...request, messages }, signal, onText);
    }
  }

  /**
   * Runs a request; while the server cannot be reached at all (connection
   * refused: it is restarting), tries again every few seconds for up to
   * `waitForServerMs`. Errors the server answered with are not retried.
   */
  private async reach<T>(go: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const until = Date.now() + this.waitMs;
    for (;;) {
      try {
        return await go();
      } catch (e) {
        const down = e instanceof TypeError || /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(String((e as Error).message) + String((e as { cause?: unknown }).cause ?? ""));
        if (!down || Date.now() > until || signal?.aborted) throw e;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async toolTurn(
    request: ProviderToolChatRequest,
    signal?: AbortSignal,
    onText?: (delta: string) => void,
  ): Promise<ProviderToolChatResult> {
    const res = await this.reach(() => fetchOk(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.chatHeaders(request.messages),
      signal,
      body: JSON.stringify({
        model: request.providerModelId,
        messages: toOpenAIMessages(request.messages),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })),
            }
          : {}),
        temperature: request.temperature,
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.stop?.length ? { stop: request.stop } : {}),
        ...(request.logitBias?.length ? { logit_bias: request.logitBias } : {}),
        max_tokens: request.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...(this.llamaCpp ? llamaCppFields(request.slotKind, this.llamaCpp.slots?.() ?? 0, this.llamaCpp.parallelChats?.() ?? 1) : {}),
        ...thinkingFields(request.thinking, !!this.llamaCpp),
      }),
    }), signal);
    if (!res.body) throw new Error("Empty response body");

    let text = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: ProviderToolChatResult["usage"];
    // The server stopped at max_tokens (finish_reason "length"): the answer or a tool call in it is cut off.
    let truncated = false;
    for await (const data of readSSE(res.body)) {
      if (data === "[DONE]") break;
      const chunk = JSON.parse(data) as UsageReport & {
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
          finish_reason?: string | null;
        }>;
        error?: { message?: string };
      };
      if (chunk.error) throw new Error(chunk.error.message ?? "Model server error");
      const delta = chunk.choices?.[0]?.delta;
      if (chunk.choices?.[0]?.finish_reason === "length") truncated = true;
      if (delta?.content) {
        text += delta.content;
        onText?.(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const index = tc.index ?? calls.size;
        const entry = calls.get(index) ?? { id: "", name: "", args: "" };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        calls.set(index, entry);
      }
      usage = readUsage(chunk, usage);
    }
    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, c]) => c.name)
      .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: parseToolArguments(c.args) }));
    // A local model that wrote its call as text (Qwen3-Coder XML, Hermes JSON): run it rather than ending the turn.
    if (!toolCalls.length && request.tools?.length) {
      const found = textToolCalls(text);
      if (found.calls.length) return { text: found.text, toolCalls: found.calls, ...(truncated ? { truncated } : {}), ...(usage ? { usage } : {}) };
    }
    return { text, toolCalls, ...(truncated ? { truncated } : {}), ...(usage ? { usage } : {}) };
  }
}

/**
 * Converts provider-neutral messages to the OpenAI chat format.
 *
 * @param messages - Agent messages.
 * @returns Messages for `/chat/completions`.
 */
export function toOpenAIMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  return messages.flatMap((m): Array<Record<string, unknown>> => {
    const pictures = (m.images ?? []).map((img) => ({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } }));
    // Tool messages can only hold text in the OpenAI format, so their pictures follow as a user message.
    if (m.role === "tool") {
      const tool = { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      return pictures.length ? [tool, { role: "user", content: [{ type: "text", text: `(The picture from ${m.toolName ?? "the tool"}.)` }, ...pictures] }] : [tool];
    }
    if (pictures.length && m.role === "user") return [{ role: "user", content: [{ type: "text", text: m.content }, ...pictures] }];
    if (m.role === "assistant" && m.toolCalls?.length) {
      return [{
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      }];
    }
    return [{ role: m.role, content: m.content }];
  });
}

/** The slot each agent kind keeps on llama.cpp's server, so one kind's prompt never pushes out another's cache. */
const SLOT_OF: Record<SlotKind, number> = { main: 0, helper: 1, other: 2 };

/**
 * The extra request fields for llama.cpp's server: always `cache_prompt` (reuse the cached part of the prompt),
 * and `id_slot` (the kind's own slot) only when the server has a slot for every kind; with fewer slots llama.cpp
 * picks the slot itself (pinning there would name a slot that does not exist). The main chat is pinned only while
 * one chat at a time is allowed: with several chats at once, pinning them all to one slot would make them wait for
 * each other, so llama.cpp picks (it prefers the idle slot whose cached prompt matches best).
 *
 * @param kind - Who asks (unset: `other`).
 * @param slots - How many slots the running server has (0 when unknown).
 * @param parallelChats - How many chats the setting lets the engine answer at once (default 1).
 * @returns The fields to add to the request body.
 */
export function llamaCppFields(kind: SlotKind | undefined, slots: number, parallelChats = 1): { cache_prompt: true; id_slot?: number } {
  const k = kind ?? "other";
  const pin = slots >= Object.keys(SLOT_OF).length && (k !== "main" || parallelChats <= 1);
  return { cache_prompt: true, ...(pin ? { id_slot: SLOT_OF[k] } : {}) };
}

/** The usage parts of an OpenAI-style answer or stream chunk, with llama.cpp's own `timings`. */
export interface UsageReport {
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null } | null;
  /** llama.cpp: `cache_n` prompt tokens came from the cache, `prompt_n` were read now, `predicted_n` were written. */
  timings?: { cache_n?: number; prompt_n?: number; predicted_n?: number } | null;
}

/**
 * Reads token counts from one answer (non-streaming) or one stream chunk, keeping what earlier chunks reported.
 * llama.cpp sends `timings` on its last chunk(s), possibly apart from `usage`; its cached count is `cache_n`, and
 * the whole prompt is `cache_n + prompt_n` when `usage` is missing. OpenAI-style servers report
 * `usage.prompt_tokens_details.cached_tokens`.
 *
 * @param chunk - The parsed answer or chunk.
 * @param prev - What earlier chunks reported.
 * @returns The usage so far, or `undefined` while nothing was reported.
 */
export function readUsage(chunk: UsageReport, prev?: ProviderUsage): ProviderUsage | undefined {
  const u = chunk.usage;
  const t = chunk.timings;
  if (!u && !t) return prev;
  const out: ProviderUsage = { ...prev };
  if (u?.prompt_tokens !== undefined) out.inputTokens = u.prompt_tokens;
  if (u?.completion_tokens !== undefined) out.outputTokens = u.completion_tokens;
  const cached = u?.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number") out.cachedTokens = cached;
  if (t) {
    if (typeof t.cache_n === "number") out.cachedTokens = t.cache_n;
    if (out.inputTokens === undefined && typeof t.prompt_n === "number") out.inputTokens = t.prompt_n + (t.cache_n ?? 0);
    if (out.outputTokens === undefined && typeof t.predicted_n === "number") out.outputTokens = t.predicted_n;
  }
  return out;
}

/** Factory for {@link OpenAICompatibleProvider}. */
export const openAICompatibleFactory: ProviderFactory = {
  type: "openai-compatible",
  displayName: "OpenAI-compatible server or API",
  categories: ["chat", "embedding"],
  create: (config) => new OpenAICompatibleProvider(config),
};

/** The host of a URL, or "" when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * A stable id for one conversation: FNV-1a (64-bit, as two 32-bit halves) over the role and text of its first two
 * messages. Not a secret and not reversible to the text in practice; only used so the provider can keep one cache.
 * @param messages - The conversation as sent.
 * @returns `kesher-` and 16 hex digits.
 */
export function conversationKey(messages: ReadonlyArray<{ role?: unknown; content?: unknown }>): string {
  const head = messages.slice(0, 2).map((m) => `${String(m.role ?? "")}:${typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")}`).join("\n");
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x01000193) >>> 0;
  }
  return `kesher-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}
