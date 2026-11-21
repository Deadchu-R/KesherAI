import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import type { GuardConfig } from "../gpu-guard.js";

/** The load-on-demand idle times (minutes per engine), which the phone may change too. */
const IDLE_KEYS = new Set(["unloadAfterMinutes", "idleEmbeddings", "idleComfy", "idleTranslator"]);

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
    const b = req.body ?? {};
    // Load on demand's idle times can be changed from the phone too (remote); the card's limits only here.
    const idleOnly = Object.keys(b).every((k) => IDLE_KEYS.has(k));
    if (!isLocalRequest(req) && !idleOnly) return reply.code(403).send({ error: "Change the limits on the computer that runs KesherAI." });
    const g = s.config.guard;
    const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined);
    if (typeof b.enabled === "boolean") g.enabled = b.enabled;
    if (typeof b.gentle === "boolean") g.gentle = b.gentle;
    g.maxTemp = int(b.maxTemp, 60, 95) ?? g.maxTemp;
    g.resumeTemp = int(b.resumeTemp, 50, 90) ?? g.resumeTemp;
    if (g.resumeTemp > g.maxTemp - 3) g.resumeTemp = g.maxTemp - 3;
    g.unloadAfterMinutes = int(b.unloadAfterMinutes, 0, 1440) ?? g.unloadAfterMinutes;
    // Load on demand: each engine's idle minutes (0 = keep it loaded).
    g.idleEmbeddings = int(b.idleEmbeddings, 0, 1440) ?? g.idleEmbeddings;
    g.idleComfy = int(b.idleComfy, 0, 1440) ?? g.idleComfy;
    g.idleTranslator = int(b.idleTranslator, 0, 1440) ?? g.idleTranslator;
    // 0 turns a limit off; otherwise a sensible range (a limit too low would hold everything).
    const limit = (v: unknown, lo: number, hi: number, cur: number) => (v === 0 ? 0 : int(v, lo, hi) ?? cur);
    g.maxRamPercent = limit(b.maxRamPercent, 50, 98, g.maxRamPercent);
    g.maxCpuPercent = limit(b.maxCpuPercent, 40, 100, g.maxCpuPercent);
    g.maxCpuTemp = limit(b.maxCpuTemp, 60, 105, g.maxCpuTemp);
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
