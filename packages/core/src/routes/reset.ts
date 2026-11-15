/**
 * Reset (Settings → Accounts, backup and data; moved out of server.ts, board t49): settings back to default, or
 * start over (both keep a backup), or install the latest version again. Only on the computer that runs KesherAI.
 */
import type { FastifyInstance } from "fastify";
import { isLocalRequest } from "../auth.js";
import { cancelFullReset, fullResetPending, listBackups, requestFullReset, requestSettingsReset } from "../reset.js";

/**
 * Routes for resetting.
 *
 * @param app - Fastify instance.
 * @param d - The data folder, the backup made by a reset at this start, how to restart, and reinstalling.
 */
export async function resetRoutes(app: FastifyInstance, d: { root: string; justReset?: unknown; restartApp?: () => void; canReinstall: boolean; reinstall: () => Promise<unknown> }): Promise<void> {
  app.get("/api/reset", async () => ({ ...(await listBackups(d.root)), pending: fullResetPending(d.root), ...(d.justReset ? { justReset: d.justReset } : {}), canRestart: !!d.restartApp, canReinstall: d.canReinstall }));
  app.post<{ Body: { kind?: "settings" | "everything" | "reinstall" | "cancel"; keepModels?: boolean } }>("/api/reset", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Reset is done on the computer that runs KesherAI." });
    const kind = req.body?.kind;
    if (kind === "settings") {
      await requestSettingsReset(d.root);
      if (d.restartApp) setTimeout(() => d.restartApp?.(), 600);
      return { ok: true, restarting: !!d.restartApp };
    }
    if (kind === "everything") {
      await requestFullReset(d.root, req.body?.keepModels !== false);
      if (d.restartApp) setTimeout(() => d.restartApp?.(), 600);
      return { ok: true, restarting: !!d.restartApp };
    }
    if (kind === "cancel") {
      await cancelFullReset(d.root);
      return { ok: true };
    }
    if (kind === "reinstall") {
      try {
        return await d.reinstall();
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
    return reply.code(400).send({ error: "Say what to reset: settings, everything, reinstall." });
  });
}
