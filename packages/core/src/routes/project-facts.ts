import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";

/**
 * Project facts on the code page: what KesherAI learned about a project from
 * its chats' commands, and removing one (it is not learned again). Only a
 * lookup by the folder's name: no file is read, so the phone may use it too.
 */
export async function projectFactsRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get<{ Querystring: { workspace?: string } }>("/api/project-facts", async (req, reply) => {
    const ws = String(req.query.workspace ?? "").trim();
    if (!ws || ws.length > 1000) return reply.code(400).send({ error: "Which project folder?" });
    return { facts: (await s.projectFacts.list(ws)).map(({ id, family, text, state, confirmations }) => ({ id, family, text, state, confirmations })) };
  });

  app.post<{ Body: { workspace?: string; id?: string } }>("/api/project-facts/remove", async (req, reply) => {
    const ws = String(req.body?.workspace ?? "").trim();
    const id = String(req.body?.id ?? "");
    if (!ws || !id || id.length > 300) return reply.code(400).send({ error: "Which fact?" });
    return (await s.projectFacts.remove(ws, id)) ? { ok: true } : reply.code(404).send({ error: "No such fact." });
  });
}
