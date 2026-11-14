import { textToolCalls } from "./text-tool-calls.js";
import { makeModelId, type AgentMessage, type ChatStreamEvent, type ModelInfo, type ModelLocation, type ToolCall } from "@kesher/shared";
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
  /** How long to keep trying while the server cannot be reached (the main KesherAI restarting for an update). */
  private readonly waitMs: number;

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
      headers: this.headers,
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
        max_tokens: request.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
    }), signal);
    if (!res.body) throw new Error("Empty response body");

    let text = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: ProviderToolChatResult["usage"];
    for await (const data of readSSE(res.body)) {
      if (data === "[DONE]") break;
      const chunk = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        error?: { message?: string };
      };
      if (chunk.error) throw new Error(chunk.error.message ?? "Model server error");
      const delta = chunk.choices?.[0]?.delta;
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
      if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
    }
    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, c]) => c.name)
      .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: parseToolArguments(c.args) }));
    // A local model that wrote its call as text (Qwen3-Coder XML, Hermes JSON): run it rather than ending the turn.
    if (!toolCalls.length && request.tools?.length) {
      const found = textToolCalls(text);
      if (found.calls.length) return { text: found.text, toolCalls: found.calls, ...(usage ? { usage } : {}) };
    }
    return { text, toolCalls, ...(usage ? { usage } : {}) };
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

/** Factory for {@link OpenAICompatibleProvider}. */
export const openAICompatibleFactory: ProviderFactory = {
  type: "openai-compatible",
  displayName: "OpenAI-compatible server or API",
  categories: ["chat", "embedding"],
  create: (config) => new OpenAICompatibleProvider(config),
};
