import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { PROMPT_TEMPLATES, type SavedPrompt } from "../prompts.js";
import { modelTurnFor } from "../conversations.js";

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
  /** "Enhance": the active chat model turns a short idea into a detailed prompt for an image or video model. */
  app.post<{ Body: { prompt?: string; kind?: "image" | "video" } }>("/api/prompts/enhance", async (req, reply) => {
    const idea = String(req.body?.prompt ?? "").trim();
    if (!idea) return reply.code(400).send({ error: "Write an idea first." });
    const id = s.config.activeModels.chat;
    if (!id) return reply.code(400).send({ error: "Choose a chat model first; it writes the better prompt." });
    const video = req.body?.kind === "video";
    const system = `You write prompts for ${video ? "a text-to-video" : "a text-to-image (Stable Diffusion / Flux)"} model. Turn the user's idea (in any language) into one detailed English prompt: subject, setting, composition, lighting, style, colours${video ? ", camera movement and action" : ", lens or medium"}. Keep what the user asked for; add no text in the picture unless asked. Answer with the prompt only, under 80 words.`;
    try {
      const r = await modelTurnFor(s.registry, id)({ messages: [{ role: "system", content: system }, { role: "user", content: idea }], tools: [] }, AbortSignal.timeout(120_000), () => undefined);
      const out = r.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim().replace(/^["'“]|["'”]$/g, "");
      return { prompt: out || idea };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/prompts/:id", async (req) => {
    await s.prompts.remove(req.params.id);
    return { ok: true };
  });
}
