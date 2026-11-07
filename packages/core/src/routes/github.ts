import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";

/**
 * "Connect with GitHub": device sign-in (a code to approve on github.com),
 * status, sign-out, and the user's own OAuth App client id for builds
 * without the project's.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function githubRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/github", async () => s.github.status());

  app.post("/api/github/connect", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Connect GitHub from the computer that runs KesherAI." });
    try {
      return await s.github.start();
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post("/api/github/cancel", async () => {
    s.github.cancel();
    return { ok: true };
  });

  app.post("/api/github/disconnect", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Disconnect GitHub from the computer that runs KesherAI." });
    await s.github.disconnect();
    await s.mcp.connect("github").catch(() => undefined);
    return { ok: true };
  });

  app.put<{ Body: { clientId?: string } }>("/api/github/client", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Change this from the computer that runs KesherAI." });
    const id = req.body?.clientId?.trim();
    if (id) s.config.github.clientId = id;
    else delete s.config.github.clientId;
    await s.saveConfig();
    return s.github.status();
  });
}
