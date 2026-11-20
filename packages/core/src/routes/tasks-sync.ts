import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import type { TasksSync } from "../tasks-sync.js";
import { isLocalRequest } from "../auth.js";

/**
 * Settings > Tasks on all your devices (tasks-sync.ts): the status, turning it on or off, syncing now and the Google
 * permission it needs. Turning on and reconnecting Google happen only on this computer, because Google sends the
 * browser back to KesherAI on 127.0.0.1; the phone sees the status, can sync now and can turn it off.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 * @param sync - The tasks sync service.
 */
export async function tasksSyncRoutes(app: FastifyInstance, s: KesherServices, sync: TasksSync): Promise<void> {
  /** The Google consent URL that adds the Drive app-folder permission (the user's other services stay). */
  const consentUrl = () => s.google.authUrl(`http://127.0.0.1:${s.config.port}/api/google/callback`, ["sync"]);

  app.get("/api/tasks-sync", async () => ({ ...(await sync.status()), configured: s.google.configured }));

  /**
   * Turns it on or off. Turning on without the permission also returns `url`: the page opens it, and sync starts
   * once Google sends the user back.
   */
  app.post<{ Body: { enabled?: unknown; workList?: unknown } }>("/api/tasks-sync", async (req, reply) => {
    // Showing or hiding Claude's work list (harmless from the phone: it only changes what the PC writes to Drive).
    if (typeof req.body?.workList === "boolean" && req.body.enabled === undefined) return sync.setWorkList(req.body.workList);
    if (typeof req.body?.enabled !== "boolean") return reply.code(400).send({ error: "Say on or off." });
    if (!req.body.enabled) return sync.setEnabled(false);
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Turn this on from the computer that runs KesherAI." });
    if (!s.google.configured) return reply.code(400).send({ error: "This copy of KesherAI has no Google sign-in built in." });
    const status = await sync.setEnabled(true);
    try {
      return s.google.has("sync") && !status.needsReconnect ? status : { ...status, url: consentUrl() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Asks Google again for the permission (after it was removed, or a sign-in that stopped working). */
  app.post("/api/tasks-sync/reconnect", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Reconnect Google from the computer that runs KesherAI." });
    try {
      return { url: consentUrl() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Syncs now (harmless from the phone: it only reads and writes the user's own Drive folder). */
  app.post("/api/tasks-sync/sync", async () => sync.syncNow());
}
