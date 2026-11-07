import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { PERSONA_TEMPLATES, type Persona } from "../personas.js";

/**
 * Personas: list (with ready-made templates), save and delete.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function personaRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/personas", async () => ({ personas: await s.personas.list(), templates: PERSONA_TEMPLATES }));
  app.post<{ Body: Partial<Persona> }>("/api/personas", async (req, reply) => {
    const b = req.body ?? {};
    if (!b.name?.trim() || !b.instructions?.trim()) return reply.code(400).send({ error: "A persona needs a name and instructions." });
    return s.personas.save({ ...b, name: b.name, instructions: b.instructions });
  });
  app.delete<{ Params: { id: string } }>("/api/personas/:id", async (req) => {
    await s.personas.remove(req.params.id);
    return { ok: true };
  });
}
