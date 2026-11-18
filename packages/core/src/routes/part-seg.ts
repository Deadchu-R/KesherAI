import type { FastifyInstance } from "fastify";
import type { PartSegmenter } from "../part-seg.js";

/** The parts engine (P3-SAM) for the 3D editor's "split by meaning": its state, setting it up, and splitting a mesh. */
export async function partSegRoutes(app: FastifyInstance, p: PartSegmenter): Promise<void> {
  app.addContentTypeParser("model/gltf-binary", { parseAs: "buffer", bodyLimit: 200 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.get("/api/part-seg", async () => p.status());
  app.post("/api/part-seg/install", async () => {
    void p.install();
    return p.status();
  });
  // A GLB of one mesh in; for each triangle its centre and part out.
  app.post("/api/part-seg/segment", { bodyLimit: 200 * 1024 * 1024 }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "Send the mesh as model/gltf-binary." });
    try {
      return { faces: await p.segment(req.body) };
    } catch (e) {
      return reply.code((e as { statusCode?: number }).statusCode ?? 500).send({ error: (e as Error).message });
    }
  });
}
