import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { SceneRooms } from "../scene-rooms.js";
import { pairedDeviceIdOf, pairedDeviceOf } from "../request-origin.js";

/**
 * Who else has the same scene open (scene-rooms.ts): the 3D editor beats about once a second with its camera and
 * selection and hears the others back. Everyone with their own key to this KesherAI (this computer, the phone, the
 * other paired devices) can join; guests cannot (their key opens only /api/guest/). The person's name is their device's,
 * set by the server, and the room's key is hashed, so the page cannot name anyone or reach another place.
 *
 * @param app - Fastify instance.
 */
export async function roomRoutes(app: FastifyInstance): Promise<void> {
  const rooms = new SceneRooms();
  const keyOf = (room: unknown) => createHash("sha256").update(String(room ?? "").slice(0, 2000)).digest("hex").slice(0, 32);
  const memberOf = (req: Parameters<typeof pairedDeviceOf>[0], tab: unknown) => `${pairedDeviceIdOf(req) ?? "this-computer"}:${String(tab ?? "").replace(/[^\w-]/g, "").slice(0, 40)}`;

  app.post<{ Body: { room?: string; tab?: string; camera?: unknown; selection?: unknown } }>("/api/rooms/beat", { bodyLimit: 32 * 1024 }, async (req, reply) => {
    if (!req.body?.room || !req.body?.tab) return reply.code(400).send({ error: "Say which scene and which tab." });
    const r = rooms.beat(keyOf(req.body.room), memberOf(req, req.body.tab), pairedDeviceOf(req) ?? "This computer", req.body);
    if ("error" in r) return reply.code(409).send(r);
    return r;
  });

  app.post<{ Body: { room?: string; tab?: string } }>("/api/rooms/leave", async (req) => {
    rooms.leave(keyOf(req.body?.room), memberOf(req, req.body?.tab));
    return { ok: true };
  });
}
