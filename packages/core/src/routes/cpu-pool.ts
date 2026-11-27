import type { FastifyInstance } from "fastify";
import { CPU_ROLES, type CpuRole } from "../cpu-pool.js";
import type { KesherServices } from "../services.js";

/** The settings the CPU models card may change (all only make the processor do more or less; the phone may too). */
interface PoolBody {
  enabled?: boolean;
  maxGenerating?: number;
  ramBudgetMb?: number;
  idleWatchdog?: number;
  idleChat?: number;
  pinCcd?: boolean;
  translatorDevice?: "cpu" | "gpu" | "auto";
}

/**
 * The pool of small models on the processor (cpu-pool.ts) for PC Health's "CPU models" card: each role's model, whether
 * it is loaded, its last tokens a second, memory and queue; and the pool's settings.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function cpuPoolRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const view = async () => {
    const cpu = s.cpuModels;
    if (!cpu) return { available: false as const, settings: s.config.cpuPool };
    await Promise.all(CPU_ROLES.map((r) => cpu.pool.describe(r)));
    return { available: true as const, engine: cpu.kind(), pinnable: !!cpu.pinnable(), settings: s.config.cpuPool, ...cpu.pool.status() };
  };

  app.get("/api/cpu-pool", view);

  app.put<{ Body: PoolBody }>("/api/cpu-pool", async (req) => {
    const b = req.body ?? {};
    const c = s.config.cpuPool;
    const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined);
    if (typeof b.enabled === "boolean") c.enabled = b.enabled;
    if (typeof b.pinCcd === "boolean") c.pinCcd = b.pinCcd;
    if (b.translatorDevice === "cpu" || b.translatorDevice === "gpu" || b.translatorDevice === "auto") c.translatorDevice = b.translatorDevice;
    c.maxGenerating = int(b.maxGenerating, 1, 4) ?? c.maxGenerating;
    // 0: a quarter of the RAM; otherwise at least 1 GB.
    c.ramBudgetMb = b.ramBudgetMb === 0 ? 0 : (int(b.ramBudgetMb, 1024, 262_144) ?? c.ramBudgetMb);
    c.idleWatchdog = int(b.idleWatchdog, 0, 1440) ?? c.idleWatchdog;
    c.idleChat = int(b.idleChat, 0, 1440) ?? c.idleChat;
    await s.saveConfig();
    return view();
  });

  /** Unloads one role's model now (when it is not answering). */
  app.post<{ Body: { role?: string } }>("/api/cpu-pool/unload", async (req, reply) => {
    const role = req.body?.role as CpuRole;
    if (!CPU_ROLES.includes(role)) return reply.code(400).send({ error: "Unknown role." });
    const done = (await s.cpuModels?.pool.unload(role)) ?? false;
    return { done, ...(await view()) };
  });
}
