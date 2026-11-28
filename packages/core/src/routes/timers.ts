/**
 * The model's waiting chat timers (chat-timers.ts): listed in the chat's header (and later the Routines page), and
 * cancelled by the user.
 */
import type { FastifyInstance } from "fastify";
import type { ChatTimers } from "../chat-timers.js";
import { isScheduled } from "../chat-schedule.js";

/**
 * Routes for chat timers.
 *
 * @param app - Fastify instance.
 * @param timers - The timers.
 * @param titleOf - A chat's title (for the Scheduled list), or undefined when it is gone.
 */
export async function timerRoutes(app: FastifyInstance, timers: ChatTimers, titleOf: (convId: string) => string | undefined = () => undefined): Promise<void> {
  // Scheduled tasks have their own list below; the timers list is the one-shot ones.
  app.get<{ Querystring: { conv?: string } }>("/api/timers", async (req) => ({ timers: timers.list(req.query.conv || undefined).filter((t) => !isScheduled(t)) }));
  // Scheduled tasks (chat-schedule.ts): one chat's, or all (Settings › Scheduled), on the computer and the phone.
  app.get<{ Querystring: { conv?: string } }>("/api/scheduled", async (req) => ({
    scheduled: timers.scheduled(req.query.conv || undefined).map((t) => ({ ...t, convTitle: titleOf(t.convId) ?? "" })),
  }));
  // Past runs (time, result excerpt, the chat), newest first.
  app.get<{ Querystring: { conv?: string } }>("/api/scheduled/runs", async (req) => ({
    runs: timers.runs(req.query.conv || undefined).map((r) => ({ ...r, convTitle: titleOf(r.convId) ?? "" })),
  }));
  app.post<{ Params: { id: string; action: string } }>("/api/scheduled/:id/:action", async (req, reply) => {
    const { id, action } = req.params;
    if (action === "run") return (await timers.runNow(id)) ? { ok: true } : reply.code(404).send({ error: "This scheduled task is gone." });
    if (action !== "pause" && action !== "resume") return reply.code(400).send({ error: "Unknown action." });
    return (await timers.setPaused(id, action === "pause")) ? { ok: true } : reply.code(404).send({ error: "This scheduled task is gone." });
  });
  app.delete<{ Params: { id: string } }>("/api/scheduled/:id", async (req, reply) => ((await timers.cancel(req.params.id)) ? { ok: true } : reply.code(404).send({ error: "This scheduled task is gone." })));
  app.delete<{ Params: { id: string } }>("/api/timers/:id", async (req, reply) => ((await timers.cancel(req.params.id)) ? { ok: true } : reply.code(404).send({ error: "This timer is no longer waiting." })));
}
