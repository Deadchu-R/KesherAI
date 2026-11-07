import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { PROMPT_TEMPLATES, type SavedPrompt } from "../prompts.js";

/**
 * The prompt library (`/` commands): list with templates, save, delete.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function promptRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/prompts", async () => ({ prompts: await s.prompts.list(), templates: PROMPT_TEMPLATES }));
  app.post<{ Body: Partial<SavedPrompt> }>("/api/prompts", async (req, reply) => {
    const b = req.body ?? {};
    try {
      return await s.prompts.save({ ...b, command: b.command ?? "", text: b.text ?? "" });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.delete<{ Params: { id: string } }>("/api/prompts/:id", async (req) => {
    await s.prompts.remove(req.params.id);
    return { ok: true };
  });
}
