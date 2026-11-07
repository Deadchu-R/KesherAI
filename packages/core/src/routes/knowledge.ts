import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import type { KnowledgeBase } from "../knowledge.js";

/**
 * Knowledge bases: list, search (anywhere the user is signed in), and
 * create, change, re-index or delete (only on this computer, since they
 * point at its folders).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function knowledgeRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const local = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Knowledge bases can be changed only on the computer they are on." });
  };

  app.get("/api/knowledge", async () => ({ bases: await s.knowledge.list() }));
  app.post<{ Body: { query?: string; base?: string; limit?: number } }>("/api/knowledge/search", async (req, reply) => {
    const q = String(req.body?.query ?? "").trim();
    if (!q) return reply.code(400).send({ error: "Type something to search for." });
    return { hits: await s.knowledge.search(q, req.body?.base, Math.min(30, Math.max(1, Number(req.body?.limit ?? 8)))) };
  });
  app.post<{ Body: Partial<KnowledgeBase> & { name?: string } }>("/api/knowledge", { preHandler: local }, async (req, reply) => {
    const b = req.body ?? {};
    if (!b.name?.trim()) return reply.code(400).send({ error: "Give the knowledge base a name." });
    return s.knowledge.save({ ...b, name: b.name });
  });
  app.post<{ Params: { id: string } }>("/api/knowledge/:id/reindex", { preHandler: local }, async (req) => {
    void s.knowledge.reindex(req.params.id).catch(() => undefined);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>("/api/knowledge/:id", { preHandler: local }, async (req) => {
    await s.knowledge.remove(req.params.id);
    return { ok: true };
  });
}
