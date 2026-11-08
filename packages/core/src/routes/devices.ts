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
  /** Starts the update on every other computer in My devices (this one is updated by the Updates page as usual). */
  app.post("/api/devices/update-all", async () => {
    await s.devices.sync().catch(() => undefined);
    return { computers: await s.devices.updateOthers() };
  });

  /** Another of my computers (it holds this one's token) says it is going to sleep, or is back. */
  app.post<{ Body: { id?: string; state?: string } }>("/api/devices/presence", async (req, reply) => {
    const id = String(req.body?.id ?? "");
    const state = req.body?.state;
    if (!/^[\w-]{8,64}$/.test(id) || (state !== "asleep" && state !== "awake")) return reply.code(400).send({ error: "id and state (asleep or awake) are needed." });
    if (!s.devices.presence(id, state)) return reply.code(404).send({ error: "Not one of your computers." });
    return { ok: true };
  });

  /** This computer is going to sleep or shutting down (from the desktop app), or woke up: tell the others. Local only. */
  app.post<{ Body: { state?: string } }>("/api/devices/announce", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only this computer can say that." });
    const state = req.body?.state === "awake" ? "awake" : "asleep";
    await s.devices.announce(state);
    return { ok: true };
  });

  app.post("/api/devices/sync", async () => {
    await s.devices.sync();
    return s.devices.status();
  });
}
