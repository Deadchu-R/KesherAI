import type { FastifyInstance } from "fastify";
import { isLocalRequest } from "../auth.js";
import type { KesherServices } from "../services.js";

/**
 * The "Continue what was running" card (resume-board.ts), the same on the computer and on the phone in remote: what
 * the last close cut off, Continue or Drop per item, and Drop for every item that waits. Who asks matters for the
 * task inbox only (Continue on this computer is the user's Run; from the phone it sends the usual approval).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function resumeRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/resume", async () => (s.resume ? s.resume.list() : { items: [] }));
  app.post<{ Params: { id: string }; Body: { action?: string } | undefined }>("/api/resume/:id", async (req, reply) => {
    const action = req.body?.action;
    if (action !== "continue" && action !== "drop") return reply.code(400).send({ error: "Continue or drop." });
    if (!s.resume) return reply.code(404).send({ error: "Nothing to continue." });
    try {
      const ok = await s.resume.act(req.params.id, action, { local: isLocalRequest(req) });
      return ok ? { ok: true } : reply.code(404).send({ error: "It is no longer waiting." });
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });
  app.post("/api/resume/drop-waiting", async () => ({ dropped: s.resume ? await s.resume.dropWaiting() : 0 }));
}
