/**
 * The model's waiting chat timers (chat-timers.ts): listed in the chat's header (and later the Routines page), and
 * cancelled by the user.
 */
import type { FastifyInstance } from "fastify";
import type { ChatTimers } from "../chat-timers.js";

/**
 * Routes for chat timers.
 *
 * @param app - Fastify instance.
 * @param timers - The timers.
 */
export async function timerRoutes(app: FastifyInstance, timers: ChatTimers): Promise<void> {
  app.get<{ Querystring: { conv?: string } }>("/api/timers", async (req) => ({ timers: timers.list(req.query.conv || undefined) }));
  app.delete<{ Params: { id: string } }>("/api/timers/:id", async (req, reply) => ((await timers.cancel(req.params.id)) ? { ok: true } : reply.code(404).send({ error: "This timer is no longer waiting." })));
}
