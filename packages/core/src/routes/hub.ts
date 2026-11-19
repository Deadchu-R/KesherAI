import type { FastifyInstance } from "fastify";
import type { HubClient } from "../hub-client.js";

/**
 * Settings → Cloud hub: the status, the hub address, on/off, what this PC accepts, pairing and forgetting. Works from
 * the phone too (a paired device with full access); the token and the key never leave this computer.
 *
 * @param app - The server.
 * @param hub - The hub link.
 */
export async function hubRoutes(app: FastifyInstance, hub: HubClient): Promise<void> {
  /** The status (no token, no key). */
  app.get("/api/hub", async () => hub.status());

  /** Body: `{ url }`, `{ enabled }` and/or `{ optIn: { acceptTasks, … } }`. */
  app.put<{ Body: { url?: unknown; enabled?: unknown; optIn?: unknown } }>("/api/hub", async (req, reply) => {
    const b = req.body ?? {};
    try {
      if (typeof b.url === "string") await hub.setUrl(b.url);
      if (b.optIn && typeof b.optIn === "object") await hub.setOptIn(b.optIn as Record<string, boolean>);
      if (typeof b.enabled === "boolean") await hub.setEnabled(b.enabled);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return hub.status();
  });

  /** Starts pairing: returns the code to approve on the hub page and this PC's key fingerprint. */
  app.post("/api/hub/pair", async (_req, reply) => {
    try {
      return await hub.pair();
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** Forgets the pairing, the token and this PC's hub key. */
  app.delete("/api/hub", async () => {
    await hub.forget();
    return hub.status();
  });
}
