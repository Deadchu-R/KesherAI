import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest, pairedDeviceIdOf, pairedDeviceOf } from "../auth.js";
import { Notifier } from "../notify.js";
import { checkEndpoint } from "../phone-push.js";

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

  // The phone app's own notifications: only a paired device with its own key (so removing the device stops them).
  const device = (req: FastifyRequest) => {
    const id = pairedDeviceIdOf(req);
    return id ? s.config.remote.devices.find((d) => d.id === id) : undefined;
  };
  const deviceOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!device(req)) return reply.code(403).send({ error: "Only the paired phone app (with its own key) gets its own notifications." });
  };
  app.get("/api/phone-push", { preHandler: deviceOnly }, async (req) => s.phonePush.status(device(req)!.id));
  /** The live connection: an event stream of notifications for as long as the phone keeps it open. */
  app.get("/api/phone-push/stream", { preHandler: deviceOnly }, async (req, reply) => {
    reply.hijack();
    s.phonePush.attach(device(req)!.id, reply.raw);
  });
  app.post<{ Body: { seq?: number } }>("/api/phone-push/ack", { preHandler: deviceOnly }, async (req) => {
    s.phonePush.ack(Number(req.body?.seq), device(req)!.id);
    return { ok: true };
  });
  /** The phone's UnifiedPush address and Web Push keys, checked first (https, a public server). */
  app.put<{ Body: { endpoint?: string; p256dh?: string; auth?: string } }>("/api/phone-push/endpoint", { preHandler: deviceOnly }, async (req, reply) => {
    const { endpoint = "", p256dh = "", auth = "" } = req.body ?? {};
    if (!/^[\w-]{86,88}$/.test(p256dh) || !/^[\w-]{21,24}$/.test(auth)) return reply.code(400).send({ error: "The phone's push keys are missing or not valid." });
    const bad = await checkEndpoint(endpoint);
    if (bad) return reply.code(400).send({ error: bad });
    device(req)!.push = { endpoint, p256dh, auth };
    await s.saveConfig();
    return s.phonePush.status(device(req)!.id);
  });
  app.delete("/api/phone-push/endpoint", { preHandler: deviceOnly }, async (req) => {
    delete device(req)!.push;
    await s.saveConfig();
    return s.phonePush.status(device(req)!.id);
  });
}
