import type { FastifyInstance, FastifyRequest } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest, pairedDeviceOf } from "../auth.js";

/**
 * "Connect with GitHub": sign-in through Git Credential Manager (on this computer) or with a device code (also from
 * a paired phone: the code shows there and the link opens there), status, the repositories the account reaches,
 * sign-out, and the user's own OAuth App client id for builds without the project's. No answer carries the token.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function githubRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  /** This computer, or a paired device with its own key (the phone keeps its rights). */
  const trusted = (req: FastifyRequest) => isLocalRequest(req) || !!pairedDeviceOf(req);

  // `gcm`: whether Git Credential Manager can sign in here (only from this computer: its window opens on the PC).
  app.get("/api/github", async (req) => ({ ...s.github.status(), gcm: isLocalRequest(req) && (await s.github.gcmAvailable()) }));

  app.get("/api/github/repos", async (_req, reply) => {
    try {
      return await s.github.repos();
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post("/api/github/connect-gcm", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Git Credential Manager signs in on the computer that runs KesherAI; on the phone, use the code." });
    if (!(await s.github.gcmAvailable())) return reply.code(400).send({ error: "Git Credential Manager is not set up for git here (Git for Windows installs it)." });
    s.github.startGcm();
    return s.github.status();
  });

  app.post("/api/github/connect", async (req, reply) => {
    if (!trusted(req)) return reply.code(403).send({ error: "Connect GitHub from the computer that runs KesherAI or a paired phone." });
    try {
      return await s.github.start();
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post("/api/github/cancel", async (req, reply) => {
    if (!trusted(req)) return reply.code(403).send({ error: "Only on this computer or a paired device." });
    s.github.cancel();
    return { ok: true };
  });

  app.post("/api/github/disconnect", async (req, reply) => {
    if (!trusted(req)) return reply.code(403).send({ error: "Disconnect GitHub from the computer that runs KesherAI or a paired phone." });
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
