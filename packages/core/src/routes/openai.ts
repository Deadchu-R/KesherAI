import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { AgentMessage, ChatMessage, ToolSpec } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { startSSE } from "../sse.js";

/** The subset of an OpenAI chat completion request KesherAI understands. */
interface OpenAIChatBody {
  model: string;
  messages: Array<{
    role: ChatMessage["role"] | "tool";
    content: string | null | Array<{ type: string; text?: string; image_url?: { url?: string } }>;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    tool_call_id?: string;
    name?: string;
  }>;
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: Record<string, unknown> } }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

function textOf(content: OpenAIChatBody["messages"][number]["content"]): string {
  if (content == null) return "";
  return typeof content === "string" ? content : content.map((p) => p.text ?? "").join("");
}

/**
 * OpenAI chat messages (with tool calls, tool results and pictures) as
 * KesherAI's own messages, so a tool-calling turn passes through whole.
 * This is what lets one of the user's computers use another one's model
 * with all its tools (Unity, files, commands…): before, only text passed and
 * the model wrote tool calls as text instead of making them.
 */
export function fromOpenAIMessages(messages: OpenAIChatBody["messages"]): AgentMessage[] {
  return messages.map((m): AgentMessage => {
    const images = Array.isArray(m.content)
      ? m.content.flatMap((p) => {
          const hit = p.type === "image_url" ? /^data:([\w/+.-]+);base64,(.+)$/.exec(p.image_url?.url ?? "") : null;
          return hit ? [{ mimeType: hit[1]!, data: hit[2]! }] : [];
        })
      : [];
    const out: AgentMessage = { role: m.role === "tool" ? "tool" : m.role, content: textOf(m.content) };
    if (images.length) out.images = images;
    if (m.role === "tool") {
      out.toolCallId = String(m.tool_call_id ?? "");
      if (m.name) out.toolName = m.name;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      out.toolCalls = m.tool_calls.map((tc, i) => {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(tc.function?.arguments || "{}") as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {
          // a model's broken arguments: passed on empty
        }
        return { id: tc.id || `call_${i}`, name: String(tc.function?.name ?? ""), arguments: args };
      });
    }
    return out;
  });
}

/** OpenAI `tools` as KesherAI tool specs (functions only). */
function toolSpecs(tools: OpenAIChatBody["tools"]): ToolSpec[] {
  return (tools ?? []).flatMap((t) => (t?.function?.name ? [{ name: t.function.name, description: t.function.description ?? "", inputSchema: t.function.parameters ?? { type: "object", properties: {} } }] : []));
}

/**
 * An OpenAI-compatible API at `/v1`, so tools like LobeHub, OpenCode,
 * Continue or any OpenAI SDK can use every chat model KesherAI knows —
 * local or cloud — through one endpoint. Model names are KesherAI's global
 * model ids (`<provider>/<model>`).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function openAIRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/v1/models", async (req) => {
    // Not the models of the user's other computers: they list their own (and two computers would list each other forever).
    const models = (await s.registry.listAllModels()).models.filter((m) => !m.providerId.startsWith("device-"));
    // Anthropic SDKs send anthropic-version and read their own list format.
    if (req.headers["anthropic-version"]) {
      const data = models.filter((m) => m.category === "chat").map((m) => ({ type: "model", id: m.id, display_name: m.name, created_at: "2025-01-01T00:00:00Z" }));
      return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
    }
    return {
      object: "list",
      data: models.filter((m) => m.category === "chat").map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.providerId })),
    };
  });

  app.post<{ Body: OpenAIChatBody }>("/v1/chat/completions", async (req, reply) => {
    const body = req.body;
    let target;
    try {
      target = s.registry.resolve(body.model);
    } catch (err) {
      return reply.code(404).send({ error: { message: (err as Error).message, type: "invalid_request_error" } });
    }
    if (!target.provider.chat) {
      return reply.code(400).send({ error: { message: `${body.model} is not a chat model`, type: "invalid_request_error" } });
    }

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // Tools (or a conversation that already has tool calls): the model's own tool calling, passed through.
    const tools = toolSpecs(body.tools);
    const hasToolTurns = body.messages.some((m) => m.role === "tool" || m.tool_calls?.length);
    if ((tools.length || hasToolTurns) && target.provider.chatWithTools) {
      const toolRequest = {
        providerModelId: target.providerModelId,
        messages: fromOpenAIMessages(body.messages),
        tools,
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
      };
      const callsOut = (calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) =>
        calls.map((c, index) => ({ index, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
      if (body.stream) {
        const sse = startSSE(req, reply);
        const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: { inputTokens?: number; outputTokens?: number }) => ({
          id, object: "chat.completion.chunk", created, model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage: { prompt_tokens: usage.inputTokens ?? 0, completion_tokens: usage.outputTokens ?? 0, total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) } } : {}),
        });
        try {
          sse.send(chunk({ role: "assistant" }, null));
          const r = await target.provider.chatWithTools(toolRequest, sse.closed, (text) => sse.send(chunk({ content: text }, null)));
          if (r.toolCalls.length) sse.send(chunk({ tool_calls: callsOut(r.toolCalls) }, null));
          sse.send(chunk({}, r.toolCalls.length ? "tool_calls" : "stop", r.usage));
          sse.send("[DONE]");
        } catch (err) {
          sse.send({ error: { message: err instanceof Error ? err.message : String(err) } });
        } finally {
          sse.end();
        }
        return;
      }
      try {
        const r = await target.provider.chatWithTools(toolRequest);
        return {
          id, object: "chat.completion", created, model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: r.text || null, ...(r.toolCalls.length ? { tool_calls: callsOut(r.toolCalls) } : {}) }, finish_reason: r.toolCalls.length ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: r.usage?.inputTokens ?? 0, completion_tokens: r.usage?.outputTokens ?? 0, total_tokens: (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0) },
        };
      } catch (err) {
        return reply.code(502).send({ error: { message: err instanceof Error ? err.message : String(err) } });
      }
    }

    const request = {
      providerModelId: target.providerModelId,
      messages: body.messages.filter((m) => m.role !== "tool").map((m) => ({ role: m.role as ChatMessage["role"], content: textOf(m.content) })),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
    };

    if (body.stream) {
      const sse = startSSE(req, reply);
      const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
        id, object: "chat.completion.chunk", created, model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      try {
        sse.send(chunk({ role: "assistant" }, null));
        for await (const ev of target.provider.chat(request, sse.closed)) {
          if (ev.type === "delta") sse.send(chunk({ content: ev.text }, null));
          else if (ev.type === "error") sse.send({ error: { message: ev.message } });
        }
        sse.send(chunk({}, "stop"));
        sse.send("[DONE]");
      } catch (err) {
        sse.send({ error: { message: err instanceof Error ? err.message : String(err) } });
      } finally {
        sse.end();
      }
      return;
    }

    let text = "";
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    for await (const ev of target.provider.chat(request)) {
      if (ev.type === "delta") text += ev.text;
      else if (ev.type === "done") usage = ev.usage;
      else if (ev.type === "error") return reply.code(502).send({ error: { message: ev.message } });
    }
    return {
      id, object: "chat.completion", created, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage?.inputTokens ?? 0,
        completion_tokens: usage?.outputTokens ?? 0,
        total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
      },
    };
  });
}
