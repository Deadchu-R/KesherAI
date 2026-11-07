import type { FastifyInstance } from "fastify";
import { randomInt } from "node:crypto";
import { ChatRequestSchema, ImageRequestSchema, features } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { startSSE } from "../sse.js";

/**
 * Generation routes: streamed chat, images, and serving the assets they
 * produce.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function generateRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  /**
   * Streams a chat completion as Server-Sent Events. Each event is a
   * `ChatStreamEvent` JSON object (`delta`, then `done` or `error`).
   */
  app.post("/api/chat", async (req, reply) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { modelId, ...rest } = parsed.data;

    let target;
    try {
      target = s.registry.resolve(modelId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    if (!target.provider.chat) return reply.code(400).send({ error: `${modelId} is not a chat model` });

    const sse = startSSE(req, reply);
    try {
      for await (const event of target.provider.chat({ providerModelId: target.providerModelId, ...rest }, sse.closed)) {
        sse.send(event);
      }
    } catch (err) {
      if (!sse.closed.aborted) sse.send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      sse.end();
    }
  });

  if (features.images) {
    /** Generates images and stores them as assets. */
    app.post("/api/images", async (req, reply) => {
      const parsed = ImageRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { modelId, seed, ...rest } = parsed.data;
      try {
        const { provider, providerModelId } = s.registry.resolve(modelId);
        if (!provider.generateImage) return reply.code(400).send({ error: `${modelId} is not an image model` });
        const files = await provider.generateImage({ providerModelId, seed: seed ?? randomInt(2 ** 31), ...rest });
        const assets = await Promise.all(
          files.map((f) => s.assets.save(f.data, f.mimeType, { sourceModelId: modelId, ...(f.meta ? { meta: f.meta } : {}) })),
        );
        return { assets };
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  app.get<{ Params: { id: string } }>("/api/assets/:id", async (req, reply) => {
    const found = await s.assets.get(req.params.id);
    if (!found) return reply.code(404).send({ error: "Asset not found" });
    return reply.type(found.asset.mimeType).header("cache-control", "private, max-age=31536000, immutable").send(found.data);
  });
}
