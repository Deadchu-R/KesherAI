import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { PERSONA_TEMPLATES, type Persona } from "../personas.js";
import { modelTurnFor } from "../conversations.js";

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
  /**
   * Agent Builder: describe an assistant in words; the active chat model
   * writes a persona draft (name, icon, instructions) and picks a knowledge
   * base and a model from what this computer has. Nothing is saved: the
   * user reviews the draft first. Body: `{ description }`.
   */
  app.post<{ Body: { description?: string } }>("/api/personas/build", async (req, reply) => {
    const description = String(req.body?.description ?? "").trim().slice(0, 4000);
    if (!description) return reply.code(400).send({ error: "Describe the assistant first." });
    const chat = s.config.activeModels.chat;
    if (!chat) return reply.code(400).send({ error: "Choose a chat model first; it writes the assistant." });
    const bases = (await s.knowledge.list()).map((b) => b.name);
    const models = (await s.registry.listAllModels()).models.filter((m) => m.category === "chat").map((m) => m.id).slice(0, 40);
    const system = `You design assistants ("personas") for a local AI app. From the user's description, write JSON only:
{"name": short name in the user's language, "icon": one emoji, "instructions": the system instructions in English (who it is, what it does, how it answers, rules, what to ask when something is missing; 80 to 250 words; it must answer in the user's language), "knowledge": one of the knowledge bases below that fits, or null, "modelId": one of the models below that fits the job best (code models for coding, bigger for hard reasoning), or null}
Knowledge bases: ${bases.length ? bases.join(", ") : "none"}
Models: ${models.join(", ") || "none"}`;
    try {
      const r = await modelTurnFor(s.registry, chat)({ messages: [{ role: "system", content: system }, { role: "user", content: description }], tools: [] }, AbortSignal.timeout(180_000), () => undefined);
      const m = /\{[\s\S]*\}/.exec(r.text.replace(/<think>[\s\S]*?<\/think>/g, ""));
      if (!m) throw new Error("The model did not answer with a persona. Try again or describe it differently.");
      const j = JSON.parse(m[0]) as { name?: string; icon?: string; instructions?: string; knowledge?: string | null; modelId?: string | null };
      if (!j.name || !j.instructions) throw new Error("The model's answer had no name or instructions. Try again.");
      return {
        name: String(j.name).slice(0, 60),
        icon: String(j.icon ?? "🤖").slice(0, 4),
        instructions: String(j.instructions).slice(0, 6000),
        ...(j.knowledge && bases.includes(j.knowledge) ? { knowledge: j.knowledge } : {}),
        ...(j.modelId && models.includes(j.modelId) ? { modelId: j.modelId } : {}),
      };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/personas/:id", async (req) => {
    await s.personas.remove(req.params.id);
    return { ok: true };
  });
}
