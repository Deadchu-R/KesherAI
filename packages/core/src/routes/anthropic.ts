import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AgentMessage, ToolSpec } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { modelTurnFor } from "../conversations.js";

/**
 * An Anthropic-compatible Messages API at `/v1/messages`, so apps and SDKs
 * written for Claude (the Anthropic SDKs, Claude Code with
 * ANTHROPIC_BASE_URL, …) can run on any model KesherAI knows, including
 * local ones. Text, images, tools (tool_use / tool_result) and streaming.
 *
 * A model name KesherAI does not know (like `claude-sonnet-…` from Claude
 * Code) goes to the active chat model.
 */

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content?: string | Array<{ type: string; text?: string }>; is_error?: boolean }
  | { type: "thinking"; thinking: string }
  | { type: string; [k: string]: unknown };

interface MessagesBody {
  model: string;
  max_tokens?: number;
  system?: string | Array<{ type: "text"; text: string }>;
  messages: Array<{ role: "user" | "assistant"; content: string | Block[] }>;
  tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown>; type?: string }>;
  stream?: boolean;
  temperature?: number;
}

const err = (reply: FastifyReply, code: number, type: string, message: string) => reply.code(code).send({ type: "error", error: { type, message } });

/**
 * Turns Anthropic messages into KesherAI's.
 *
 * @param body - The request.
 * @returns Messages for the model.
 */
export function toAgentMessages(body: Pick<MessagesBody, "system" | "messages">): AgentMessage[] {
  const out: AgentMessage[] = [];
  const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text).join("\n\n");
  if (system.trim()) out.push({ role: "system", content: system });
  for (const m of body.messages ?? []) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const texts: string[] = [];
    const images: Array<{ mimeType: string; data: string }> = [];
    const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    for (const b of m.content) {
      if (b.type === "text") texts.push(String((b as { text: string }).text));
      else if (b.type === "image") {
        const src = (b as { source: { type: string; media_type?: string; data?: string } }).source;
        if (src.type === "base64" && src.data) images.push({ mimeType: src.media_type ?? "image/png", data: src.data });
      } else if (b.type === "tool_use") {
        const u = b as { id: string; name: string; input: Record<string, unknown> };
        calls.push({ id: u.id, name: u.name, arguments: u.input ?? {} });
      } else if (b.type === "tool_result") {
        const r = b as { tool_use_id: string; content?: string | Array<{ type: string; text?: string }>; is_error?: boolean };
        const content = typeof r.content === "string" ? r.content : (r.content ?? []).map((c) => c.text ?? "").join("\n");
        out.push({ role: "tool", toolCallId: r.tool_use_id, content: r.is_error ? `Error: ${content}` : content });
      }
    }
    if (texts.length || images.length || calls.length) {
      out.push({ role: m.role, content: texts.join("\n"), ...(images.length ? { images } : {}), ...(calls.length ? { toolCalls: calls } : {}) });
    }
  }
  // Tool results name their tool (some models need it).
  const names = new Map(out.flatMap((m) => (m.toolCalls ?? []).map((c) => [c.id, c.name] as const)));
  return out.map((m) => (m.role === "tool" && m.toolCallId && names.has(m.toolCallId) ? { ...m, toolName: names.get(m.toolCallId)! } : m));
}

const estimate = (msgs: AgentMessage[], tools: ToolSpec[]) => Math.ceil((msgs.reduce((n, m) => n + m.content.length + (m.images?.length ?? 0) * 6000, 0) + JSON.stringify(tools).length) / 4);

/**
 * The Messages API routes.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function anthropicRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const pick = (name: string): string | undefined => {
    try {
      s.registry.resolve(name);
      return name;
    } catch {
      return s.config.activeModels.chat;
    }
  };
  const toolsOf = (b: MessagesBody): ToolSpec[] =>
    (b.tools ?? []).filter((t) => t.name && !t.type?.startsWith("web_search")).map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.input_schema ?? { type: "object", properties: {} } }));

  app.post<{ Body: MessagesBody }>("/v1/messages/count_tokens", async (req, reply) => {
    if (!Array.isArray(req.body?.messages)) return err(reply, 400, "invalid_request_error", "messages: an array is required");
    return { input_tokens: estimate(toAgentMessages(req.body), toolsOf(req.body)) };
  });

  app.post<{ Body: MessagesBody }>("/v1/messages", async (req, reply) => {
    const body = req.body;
    if (!body || !Array.isArray(body.messages)) return err(reply, 400, "invalid_request_error", "messages: an array is required");
    const modelId = pick(String(body.model ?? ""));
    if (!modelId) return err(reply, 404, "not_found_error", `Unknown model ${body.model}, and no chat model is active in KesherAI.`);
    const messages = toAgentMessages(body);
    const tools = toolsOf(body);
    const turn = modelTurnFor(s.registry, modelId);
    const id = `msg_${randomUUID().replace(/-/g, "")}`;
    const input = estimate(messages, tools);
    const blocks = (text: string, calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) => [
      ...(text ? [{ type: "text", text }] : []),
      ...calls.map((c) => ({ type: "tool_use", id: c.id.startsWith("toolu_") ? c.id : `toolu_${c.id}`, name: c.name, input: c.arguments })),
    ];
    const clean = (t: string) => t.replace(/<think>[\s\S]*?<\/think>\s*/g, "");

    if (!body.stream) {
      try {
        const r = await turn({ messages, tools }, AbortSignal.timeout(30 * 60_000), () => undefined);
        const text = clean(r.text);
        return {
          id,
          type: "message",
          role: "assistant",
          model: body.model,
          content: blocks(text, r.toolCalls),
          stop_reason: r.toolCalls.length ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: r.usage?.inputTokens ?? input, output_tokens: r.usage?.outputTokens ?? Math.ceil(text.length / 4) },
        };
      } catch (e) {
        return err(reply, 502, "api_error", (e as Error).message);
      }
    }

    const abort = new AbortController();
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    reply.raw.on("close", () => !reply.raw.writableFinished && abort.abort());
    const send = (event: string, data: unknown) => !reply.raw.writableEnded && reply.raw.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`);
    send("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 0 } } });
    let index = -1;
    let open = false;
    let raw = "";
    let shown = 0;
    let out = 0;
    // Text streams as it comes, except a <think>…</think> part at the start, which is left out.
    const flush = () => {
      const visible = clean(raw);
      if (/^\s*<think>/.test(visible) && !/<\/think>/.test(raw)) return;
      const delta = visible.slice(shown);
      if (!delta) return;
      if (!open) {
        index++;
        open = true;
        send("content_block_start", { index, content_block: { type: "text", text: "" } });
      }
      send("content_block_delta", { index, delta: { type: "text_delta", text: delta } });
      shown += delta.length;
      out += delta.length;
    };
    try {
      const r = await turn({ messages, tools }, abort.signal, (t) => {
        raw += t;
        flush();
      });
      if (!raw && r.text) {
        raw = r.text;
        flush();
      }
      if (open) send("content_block_stop", { index });
      for (const c of r.toolCalls) {
        index++;
        const b = { type: "tool_use", id: c.id.startsWith("toolu_") ? c.id : `toolu_${c.id}`, name: c.name, input: {} };
        send("content_block_start", { index, content_block: b });
        send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.arguments) } });
        send("content_block_stop", { index });
      }
      send("message_delta", { delta: { stop_reason: r.toolCalls.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: r.usage?.outputTokens ?? Math.ceil(out / 4) } });
      send("message_stop", {});
    } catch (e) {
      send("error", { error: { type: "api_error", message: (e as Error).message } });
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });
}
