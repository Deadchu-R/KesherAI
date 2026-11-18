import type { FastifyInstance } from "fastify";
import type { BgRemover } from "../bg-remove.js";

/** The background remover (rembg + BiRefNet) for the image editor: its state, setting it up, and cutting out a picture. */
export async function bgRemoveRoutes(app: FastifyInstance, b: BgRemover): Promise<void> {
  app.get("/api/bg-remove", async () => b.status());
  app.post("/api/bg-remove/install", async () => {
    void b.install();
    return b.status();
  });
  // A picture in (its bytes, as application/octet-stream; its kind is read from them); the PNG with the background clear
  // out. ?model= one of BG_MODELS; ?x=&y= a point (SAM); ?mask=1 the mask instead.
  app.post<{ Querystring: { model?: string; x?: string; y?: string; mask?: string } }>("/api/bg-remove/remove", { bodyLimit: 60 * 1024 * 1024 }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "Send the picture's bytes as application/octet-stream." });
    try {
      const point = req.query.x !== undefined && req.query.y !== undefined ? ([Number(req.query.x), Number(req.query.y)] as [number, number]) : undefined;
      return reply.type("image/png").send(await b.remove(req.body, req.query.model || undefined, { point, mask: req.query.mask === "1" }));
    } catch (e) {
      return reply.code((e as { statusCode?: number }).statusCode ?? 500).send({ error: (e as Error).message });
    }
  });
}
