import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { mergeLightSettings } from "../heavy-app.js";

/**
 * The automatic light profile (heavy-app.ts): its status (also for the phone) and its settings (this computer only,
 * like the guard's limits).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function lightProfileRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const view = () => ({ ...(s.lightProfile?.status() ?? { on: false, enabled: s.config.lightProfile.enabled, apps: [], unloaded: [] }), settings: s.config.lightProfile });

  app.get("/api/light-profile", async () => view());

  app.put<{ Body: unknown }>("/api/light-profile", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Change the light profile on the computer that runs KesherAI." });
    s.config.lightProfile = mergeLightSettings(s.config.lightProfile, req.body);
    await s.saveConfig();
    await s.lightProfile?.tick().catch(() => undefined);
    return view();
  });
}
