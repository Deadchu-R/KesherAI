import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadSkillBody } from "@kesher/skills";
import { features } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";

/**
 * Skills: list, read, write, install from GitHub (only on this computer)
 * and delete.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function skillRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  if (!features.skills) return;
  const local = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Skills can be installed only on this computer." });
  };
  app.get("/api/skills", async () => (await s.skills.list()).map(({ dir: _d, ...k }) => k));
  app.get<{ Params: { name: string } }>("/api/skills/:name", async (req, reply) => {
    const skill = (await s.skills.list()).find((k) => k.name === req.params.name);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    const { dir: _d, ...rest } = skill;
    return { ...rest, body: await loadSkillBody(skill) };
  });
  app.post<{ Body: { name?: string; description?: string; body?: string } }>("/api/skills", async (req, reply) => {
    try {
      await s.skills.save({ name: req.body?.name ?? "", description: req.body?.description ?? "", body: req.body?.body ?? "" });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.post<{ Body: { source?: string } }>("/api/skills/install", { preHandler: local }, async (req, reply) => {
    try {
      return { installed: await s.skills.install(String(req.body?.source ?? "")) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.delete<{ Params: { name: string } }>("/api/skills/:name", { preHandler: local }, async (req, reply) => {
    try {
      await s.skills.remove(req.params.name);
      return { ok: true };
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });
}
