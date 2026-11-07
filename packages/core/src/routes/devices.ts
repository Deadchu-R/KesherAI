import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";

/**
 * "My devices": the user's other computers (same Google account), sharing
 * this computer with them, and syncing API keys and MCP servers. Changing
 * these is allowed only from this computer.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function deviceRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/devices", async () => s.devices.status());

  app.put<{ Body: { share?: boolean; syncSettings?: boolean } }>("/api/devices", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Change this on the computer itself." });
    if (typeof req.body?.share === "boolean") await s.devices.setShare(req.body.share);
    if (typeof req.body?.syncSettings === "boolean") await s.devices.setSyncSettings(req.body.syncSettings);
    return s.devices.status();
  });

  /** For the phone app (it holds this computer's token): the user's other computers, to add them. */
  app.get("/api/devices/peers", async () => s.devices.peers());

  app.post("/api/devices/sync", async () => {
    await s.devices.sync();
    return s.devices.status();
  });
}
