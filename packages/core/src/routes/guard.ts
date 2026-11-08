import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import type { GuardConfig } from "../gpu-guard.js";

/**
 * Protecting the graphics card (Settings → Graphics cards): live readings,
 * pause / resume, and the limits.
 *
 * Pausing, resuming and freeing memory work from the phone too: they only
 * ever make the card do less. Changing the limits works only on this computer.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function guardRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/guard", async () => s.guard.status());

  app.put<{ Body: Partial<GuardConfig> }>("/api/guard", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Change the limits on the computer that runs KesherAI." });
    const b = req.body ?? {};
    const g = s.config.guard;
    const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined);
    if (typeof b.enabled === "boolean") g.enabled = b.enabled;
    if (typeof b.gentle === "boolean") g.gentle = b.gentle;
    g.maxTemp = int(b.maxTemp, 60, 95) ?? g.maxTemp;
    g.resumeTemp = int(b.resumeTemp, 50, 90) ?? g.resumeTemp;
    if (g.resumeTemp > g.maxTemp - 3) g.resumeTemp = g.maxTemp - 3;
    g.unloadAfterMinutes = int(b.unloadAfterMinutes, 0, 1440) ?? g.unloadAfterMinutes;
    await s.saveConfig();
    await s.guard.check().catch(() => undefined);
    return s.guard.status();
  });

  /** Holds (or lets go of) all new local work. */
  app.post<{ Body: { on?: boolean } }>("/api/guard/pause", async (req) => {
    s.guard.setPaused(req.body?.on !== false);
    return s.guard.status();
  });

  /** Unloads idle models now, to free the card's memory. */
  app.post("/api/guard/free", async (_req, reply) => {
    const st = s.guard.status();
    if (st.running > 0) return reply.code(409).send({ error: "A model is working right now; try again when it finishes." });
    await s.guard.freeNow();
    return s.guard.status();
  });
}
