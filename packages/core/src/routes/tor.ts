import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";

/**
 * Tor for blocked pages: its state, Install (a download from torproject.org, checked against Tor's checksums) and
 * Remove. Installing and removing happen only on this computer; the phone sees the state.
 */
export async function torRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/tor", async () => s.tor.status());
  app.post("/api/tor/install", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Install Tor on the computer that runs KesherAI." });
    if ((await s.tor.status()).job?.state === "downloading") return reply.code(409).send({ error: "Already downloading." });
    void s.tor.install().catch(() => undefined);
    return s.tor.status();
  });
  app.post("/api/tor/remove", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Remove Tor on the computer that runs KesherAI." });
    await s.tor.remove();
    return s.tor.status();
  });
}
