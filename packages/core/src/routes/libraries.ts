import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";

/**
 * The library store: list the catalog and what is installed, install a
 * library (from the catalog, or a GitHub repository at a ref), remove one.
 * Installing only downloads documentation into KesherAI's own folder, so it
 * is allowed from the phone too (like downloading a model).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function librariesRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/libraries", async () => s.libraries.list());
  app.post<{ Body: { id?: string; name?: string; repo?: string; ref?: string; path?: string } }>("/api/libraries/install", async (req, reply) => {
    const b = req.body ?? {};
    try {
      const target = b.id ? String(b.id) : { name: String(b.name ?? b.repo ?? ""), repo: String(b.repo ?? ""), ref: String(b.ref ?? "refs/heads/main"), path: String(b.path ?? "") };
      // Started in the background; the page polls /api/libraries for "installing".
      const job = s.libraries.install(target);
      job.catch(() => undefined);
      const done = await Promise.race([job, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
      return done ?? { started: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  app.delete<{ Params: { id: string } }>("/api/libraries/:id", async (req) => {
    await s.libraries.remove(req.params.id);
    return { ok: true };
  });
}
