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
    /** LoRAs for the local image engine: name them in a prompt as `<lora:name:weight>`. */
    app.get("/api/loras", async () => ({ dir: s.sd.loraDir, loras: await s.sd.loras() }));
    app.delete<{ Params: { name: string } }>("/api/loras/:name", async (req, reply) =>
      (await s.sd.removeLora(req.params.name)) ? { ok: true } : reply.code(404).send({ error: "No such LoRA" }),
    );

    /** Making images larger (batch tools): status, setup, and one image at a time. */
    app.get("/api/images/upscale", async () => s.sd.upscaleStatus());
    app.post("/api/images/upscale/setup", async (_req, reply) => {
      void s.sd.prepareUpscaler().catch(() => undefined);
      return reply.code(202).send({ ok: true });
    });
    app.addContentTypeParser(["image/png"], { parseAs: "buffer", bodyLimit: 40 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    app.post("/api/images/upscale", async (req, reply) => {
      const png = req.body as Buffer;
      if (!Buffer.isBuffer(png) || png.subarray(1, 4).toString() !== "PNG") return reply.code(400).send({ error: "Send a PNG image as image/png." });
      if (!(await s.sd.upscaleStatus()).ready) return reply.code(409).send({ error: "needs-setup", code: "needs-setup" });
      const ac = new AbortController();
      reply.raw.on("close", () => !reply.raw.writableFinished && ac.abort());
      try {
        return reply.type("image/png").send(await s.sd.upscale(png, ac.signal));
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    });

    /** Generates images and stores them as assets. */
    app.post("/api/images", { bodyLimit: 60 * 1024 * 1024 }, async (req, reply) => {
      const parsed = ImageRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { modelId, seed, initImage, mask, ...rest } = parsed.data;
      const png = (b64?: string) => (b64 ? new Uint8Array(Buffer.from(b64.replace(/^data:[^,]+,/, ""), "base64")) : undefined);
      try {
        const { provider, providerModelId } = s.registry.resolve(modelId);
        if (!provider.generateImage) return reply.code(400).send({ error: `${modelId} is not an image model` });
        const init = png(initImage);
        const maskPng = init ? png(mask) : undefined;
        const files = await provider.generateImage({ providerModelId, seed: seed ?? randomInt(2 ** 31), ...rest, ...(init ? { initImage: init } : {}), ...(maskPng ? { mask: maskPng } : {}) });
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
