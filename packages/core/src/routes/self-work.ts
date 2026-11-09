import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { isLocalRequest } from "../auth.js";
import type { KesherServices } from "../services.js";

/**
 * Self-work: start, follow and stop KesherAI working on a git project by itself.
 * A new project folder and its check command are chosen only on the computer;
 * the phone can start again with the same folder and check, follow, and stop.
 */
export async function selfWorkRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/self-work", async () => ({ run: s.selfWork?.current ?? null }));

  app.post<{ Body: { repo?: string; goal?: string; hours?: number; check?: string; modelId?: string } }>("/api/self-work/start", async (req, reply) => {
    const sw = s.selfWork;
    if (!sw) return reply.code(503).send({ error: "Self-work is not ready yet." });
    const b = req.body ?? {};
    const repo = resolve(String(b.repo ?? ""));
    const check = String(b.check ?? "").trim();
    const last = sw.current;
    if (!isLocalRequest(req) && !(last && last.repo === repo && last.check === check)) {
      return reply.code(403).send({ error: "Choose the project and its check on the computer first; from the phone you can start again with the same ones." });
    }
    const home = resolve(homedir());
    if (!b.repo || !isAbsolute(String(b.repo)) || !(repo + sep).startsWith(home + sep)) return reply.code(400).send({ error: "The project must be a folder inside your home folder." });
    if (b.modelId !== undefined && typeof b.modelId !== "string") return reply.code(400).send({ error: "modelId is text." });
    try {
      const run = await sw.start({ repo, goal: String(b.goal ?? ""), ...(b.hours !== undefined ? { hours: Number(b.hours) } : {}), check, ...(b.modelId ? { modelId: b.modelId } : {}) });
      return { run };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post("/api/self-work/stop", async () => {
    const sw = s.selfWork;
    const run = sw?.current;
    if (sw && run) {
      await sw.stop();
      s.conversations.stop(run.convId);
    }
    return { run: sw?.current ?? null };
  });
}
