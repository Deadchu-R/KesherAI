import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { startSSE } from "../sse.js";

/** The subset of an OpenAI chat completion request KesherAI understands. */
interface OpenAIChatBody {
  model: string;
  messages: Array<{ role: ChatMessage["role"]; content: string | Array<{ type: string; text?: string }> }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

function textOf(content: OpenAIChatBody["messages"][number]["content"]): string {
  return typeof content === "string" ? content : content.map((p) => p.text ?? "").join("");
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
    const request = {
      providerModelId: target.providerModelId,
      messages: body.messages.map((m) => ({ role: m.role, content: textOf(m.content) })),
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
