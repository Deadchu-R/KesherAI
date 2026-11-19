import type { FastifyInstance } from "fastify";
import { roomKey, type SceneRooms } from "../scene-rooms.js";
import { pairedDeviceIdOf, pairedDeviceOf } from "../request-origin.js";

/**
 * Who else has the same scene open (scene-rooms.ts): the 3D editor beats about once a second with its camera and
 * selection and hears the others back. Everyone with their own key to this KesherAI (this computer, the phone, the
 * other paired devices) can join here; guests of a shared project join the same rooms through /api/guest/rooms/*
 * (routes/guests.ts), with their limits. The person's name is their device's, set by the server, and the room's key is
 * hashed, so the page cannot name anyone or reach another place.
 *
 * @param app - Fastify instance.
 * @param rooms - The rooms, shared with the guests' routes.
 */
export async function roomRoutes(app: FastifyInstance, rooms: SceneRooms): Promise<void> {
  const memberOf = (req: Parameters<typeof pairedDeviceOf>[0], tab: unknown) => `${pairedDeviceIdOf(req) ?? "this-computer"}:${String(tab ?? "").replace(/[^\w-]/g, "").slice(0, 40)}`;

  app.post<{ Body: { room?: string; tab?: string; camera?: unknown; selection?: unknown } }>("/api/rooms/beat", { bodyLimit: 32 * 1024 }, async (req, reply) => {
    if (!req.body?.room || !req.body?.tab) return reply.code(400).send({ error: "Say which scene and which tab." });
    const r = rooms.beat(await roomKey(req.body.room), memberOf(req, req.body.tab), pairedDeviceOf(req) ?? "This computer", req.body);
    if ("error" in r) return reply.code(409).send(r);
    return { others: r.others };
  });

  app.post<{ Body: { room?: string; tab?: string } }>("/api/rooms/leave", async (req) => {
    rooms.leave(await roomKey(req.body?.room), memberOf(req, req.body?.tab));
    return { ok: true };
  });
}
