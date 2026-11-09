import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest, pairedDeviceOf } from "../auth.js";
import { Notifier } from "../notify.js";

/**
 * Notification settings and a test: on this computer, and from a paired
 * device with its own key (the phone app's Settings). From a device, the
 * ntfy server and "include the text" cannot be changed: they decide where
 * the notifications' contents go.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function notificationRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const local = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLocalRequest(req) && !pairedDeviceOf(req)) return reply.code(403).send({ error: "Notifications can be set up on this computer or from a paired device." });
  };
  const view = () => {
    const n = s.config.notifications;
    const topic = n.ntfy.topic ?? "";
    return { ...n, subscribeUrl: `${n.ntfy.server.replace(/\/$/, "")}/${topic}`, recent: s.notifier.sent.slice(-10).reverse() };
  };
  app.get("/api/notifications", { preHandler: local }, async () => view());
  app.put<{ Body: { ntfy?: { enabled?: boolean; server?: string }; desktop?: boolean; minSeconds?: number; includeText?: boolean; waiting?: boolean; approveButtons?: boolean; waitingSeconds?: number; newTopic?: boolean } }>(
    "/api/notifications",
    { preHandler: local },
    async (req, reply) => {
      const b = req.body ?? {};
      const n = s.config.notifications;
      // From a device: not where notifications go or whether they carry text, and not turning phone alerts off
      // (a stolen phone must not silence the "someone tried to get in" alerts).
      if (!isLocalRequest(req) && ((b.ntfy?.server !== undefined && b.ntfy.server.trim().replace(/\/$/, "") !== n.ntfy.server) || b.includeText === true || (b.ntfy?.enabled === false && n.ntfy.enabled) || b.newTopic === true))
        return reply.code(403).send({ error: "Where notifications go (the server, a new topic), whether they carry the text, and turning phone notifications off are changed only on the computer itself." });
      if (b.ntfy?.server !== undefined) {
        if (!/^https?:\/\/[^\s/]+/.test(b.ntfy.server)) return reply.code(400).send({ error: "The ntfy server is an address like https://ntfy.sh" });
        n.ntfy.server = b.ntfy.server.trim().replace(/\/$/, "");
      }
      if (b.ntfy?.enabled !== undefined) n.ntfy.enabled = !!b.ntfy.enabled;
      if (b.newTopic || !n.ntfy.topic) n.ntfy.topic = Notifier.newTopic();
      if (b.desktop !== undefined) n.desktop = !!b.desktop;
      if (b.includeText !== undefined) n.includeText = !!b.includeText;
      if (b.waiting !== undefined) n.waiting = !!b.waiting;
      if (b.approveButtons !== undefined) n.approveButtons = !!b.approveButtons;
      if (b.waitingSeconds !== undefined) n.waitingSeconds = Math.min(3600, Math.max(0, Math.round(Number(b.waitingSeconds) || 0)));
      if (b.minSeconds !== undefined) n.minSeconds = Math.min(3600, Math.max(0, Math.round(Number(b.minSeconds) || 0)));
      await s.saveConfig();
      return view();
    },
  );
  app.post("/api/notifications/test", { preHandler: local }, async (_req, reply) => {
    try {
      const channels = await s.notifier.send({ title: "KesherAI", body: "Notifications work. You will get one when long work is done.", path: "#/", tags: ["tada"] }, true);
      return { channels };
    } catch (e) {
      return reply.code(502).send({ error: `The phone notification did not go out: ${(e as Error).message}` });
    }
  });
}
