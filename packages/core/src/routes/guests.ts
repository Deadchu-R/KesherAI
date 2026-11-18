import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { KesherServices } from "../services.js";
import { GuestInvites, GuestQuota, GuestWatch, guestName, guestOf, guestScope, type GuestAlert, type GuestRole } from "../guests.js";
import { clientAddress } from "../auth.js";
import { pairedDeviceIdOf } from "../request-origin.js";

/**
 * Working together on one project (docs/COLLABORATION.md, stage 1). Three kinds of routes:
 * - the owner's: make an invite link, see who has access, remove someone;
 * - the invite link's: `/api/join/:token` (the token is the key; the auth hook lets only this route take it);
 * - the guest's: `/api/guest/*`, the only routes a guest key opens (auth.ts), each checked against the guest's own
 *   project. A guest reads the project's chats; with "edit" a guest starts chats of their own there and writes in
 *   those only (never in the owner's chats, which can use tools). Guest chats have no tools and no memory.
 */
export async function guestRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const invites = new GuestInvites(join(s.paths.root, "guest-invites.json"));
  const quota = new GuestQuota();
  const limit = () => s.config.remote.guestDailyLimit;
  const devices = () => s.config.remote.devices;
  const watch = new GuestWatch();

  // The owner hears about a guest trying to go outside the project, coming from a new address, or flooding requests.
  app.addHook("onResponse", async (req, reply) => {
    const id = pairedDeviceIdOf(req);
    const d = id ? devices().find((x) => x.id === id) : undefined;
    const g = guestOf(d?.scope);
    if (!d || !g) return;
    const project = s.library.getProject(g.projectId)?.name ?? "";
    const who = d.name.replace(/ \(guest\)$/, "");
    const say: Record<GuestAlert, string> = {
      outside: `${who} tried to reach something outside the shared project "${project}" (refused).`,
      "new-address": `${who} came into "${project}" from a new network address.`,
      busy: `${who} sent very many requests in a minute to "${project}".`,
    };
    for (const a of watch.see(d.id, clientAddress(req), reply.statusCode)) {
      void s.notifier.send({ title: "KesherAI: a guest", body: say[a], tags: ["warning"], priority: a === "outside" ? 4 : 3 }).catch(() => undefined);
    }
  });

  /** The guest behind a request (by its device key), or undefined for anyone else. */
  const guestBehind = (req: FastifyRequest) => {
    const id = pairedDeviceIdOf(req);
    const d = id ? devices().find((x) => x.id === id) : undefined;
    const g = guestOf(d?.scope);
    return d && g && s.library.getProject(g.projectId) ? { id: d.id, name: d.name, ...g } : undefined;
  };
  const refuse = (reply: FastifyReply) => reply.code(403).send({ error: "Only a guest of a shared project can use this." });

  // ---- The owner's (a guest key cannot reach these: auth.ts sends it only to /api/guest/*). ----

  /** A one-time invite link's token for a project: `{ role, hours }`. */
  app.post<{ Params: { id: string }; Body: { role?: GuestRole; hours?: number } }>("/api/projects/:id/invites", async (req, reply) => {
    if (!s.library.getProject(req.params.id)) return reply.code(404).send({ error: "No such project." });
    try {
      const { token, invite } = await invites.create(req.params.id, req.body?.role ?? "read", Number(req.body?.hours ?? 24));
      return { token, expiresAt: invite.expiresAt, role: invite.role };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Who has access to the project, and its invites. */
  app.get<{ Params: { id: string } }>("/api/projects/:id/guests", async (req, reply) => {
    if (!s.library.getProject(req.params.id)) return reply.code(404).send({ error: "No such project." });
    const people = devices()
      .filter((d) => guestOf(d.scope)?.projectId === req.params.id)
      .map((d) => ({ id: d.id, name: d.name, role: guestOf(d.scope)!.role, joinedAt: d.createdAt, lastSeen: d.lastSeen ?? null, left: quota.left(d.id, limit()) }));
    return { people, invites: await invites.list(req.params.id), dailyLimit: limit() };
  });

  /** Removes a guest: their key stops at once. */
  app.delete<{ Params: { id: string; guest: string } }>("/api/projects/:id/guests/:guest", async (req, reply) => {
    const d = devices().find((x) => x.id === req.params.guest);
    if (!d || guestOf(d.scope)?.projectId !== req.params.id) return reply.code(404).send({ error: "No such guest." });
    await s.deviceKeys?.remove(d.id);
    return { ok: true };
  });

  /** Cancels an invite that was not used yet. */
  app.delete<{ Params: { id: string; invite: string } }>("/api/projects/:id/invites/:invite", async (req, reply) => ((await invites.cancel(req.params.invite)) ? { ok: true } : reply.code(404).send({ error: "No such invite." })));

  // ---- The invite link (no key: the one-time token is the key). ----

  /** What the link is for, before the guest writes a name. */
  app.get<{ Params: { token: string } }>("/api/join/:token", async (req, reply) => {
    const i = await invites.open(req.params.token);
    const p = i && s.library.getProject(i.projectId);
    if (!i || !p) return reply.code(404).send({ error: "This invite link was used already or has ended. Ask for a new one." });
    return { project: p.name, role: i.role, expiresAt: i.expiresAt };
  });

  /** Joins: the guest's own key (given once), and the owner is told. */
  app.post<{ Params: { token: string }; Body: { name?: string } }>("/api/join/:token", { bodyLimit: 2048 }, async (req, reply) => {
    const name = guestName(String(req.body?.name ?? ""));
    if (!name) return reply.code(400).send({ error: "Write your name." });
    const i = await invites.use(req.params.token, name);
    const p = i && s.library.getProject(i.projectId);
    if (!i || !p || !s.deviceKeys) return reply.code(404).send({ error: "This invite link was used already or has ended. Ask for a new one." });
    const key = await s.deviceKeys.issue(`${name} (guest)`, guestScope(i.projectId, i.role));
    void s.notifier.send({ title: "KesherAI", body: `${name} joined the project "${p.name}" (${i.role === "edit" ? "read and write" : "read"}).`, tags: ["busts_in_silhouette"] }).catch(() => undefined);
    return { key, project: p.name, role: i.role };
  });

  // ---- The guest's (the only routes a guest key opens). ----

  app.get("/api/guest/me", async (req, reply) => {
    const g = guestBehind(req);
    if (!g) return refuse(reply);
    return { name: g.name.replace(/ \(guest\)$/, ""), project: s.library.getProject(g.projectId)!.name, role: g.role, left: quota.left(g.id, limit()), dailyLimit: limit() };
  });

  app.get("/api/guest/chats", async (req, reply) => {
    const g = guestBehind(req);
    if (!g) return refuse(reply);
    return { chats: s.library.listConversations(g.projectId).filter((c) => c.kind === "chat").map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, mine: c.source === "guest" })) };
  });

  /** One chat of the project: its messages (text only: no tool output, no files). */
  app.get<{ Params: { id: string } }>("/api/guest/chats/:id", async (req, reply) => {
    const g = guestBehind(req);
    if (!g) return refuse(reply);
    const c = s.library.summary(req.params.id);
    if (!c || c.projectId !== g.projectId || c.kind !== "chat") return reply.code(404).send({ error: "No such chat in this project." });
    const opened = await s.conversations.open(c.id);
    if (!opened) return reply.code(404).send({ error: "No such chat in this project." });
    const messages = opened.session.events
      .filter((e): e is Extract<typeof e, { type: "user" | "assistant" }> => e.type === "user" || e.type === "assistant")
      .map((e) => ({ seq: e.seq, role: e.type, text: e.text.slice(0, 40_000) }));
    return { id: c.id, title: c.title, mine: c.source === "guest", busy: opened.session.info().status === "running", messages };
  });

  /** A new chat of the guest's own in the project (edit only). */
  app.post("/api/guest/chats", async (req, reply) => {
    const g = guestBehind(req);
    if (!g) return refuse(reply);
    if (g.role !== "edit") return reply.code(403).send({ error: "You can read this project, not write in it." });
    try {
      const c = await s.conversations.create({ kind: "chat", projectId: g.projectId, source: "guest", incognito: true, title: `${g.name.replace(/ \(guest\)$/, "")}: new chat` });
      return { id: c.id };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** A message in one of the guest's own chats (edit only), counted against the daily allowance. */
  app.post<{ Params: { id: string }; Body: { text?: string } }>("/api/guest/chats/:id/messages", { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const g = guestBehind(req);
    if (!g) return refuse(reply);
    if (g.role !== "edit") return reply.code(403).send({ error: "You can read this project, not write in it." });
    const c = s.library.summary(req.params.id);
    if (!c || c.projectId !== g.projectId || c.source !== "guest") return reply.code(403).send({ error: "You can write only in chats you started in this project." });
    const text = String(req.body?.text ?? "").trim().slice(0, 20_000);
    if (!text) return reply.code(400).send({ error: "Empty message" });
    const left = quota.take(g.id, limit());
    if (left < 0) return reply.code(429).send({ error: `That is today's ${limit()} answers. More tomorrow.` });
    try {
      await s.conversations.send(c.id, text);
      return { ok: true, left };
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });
}
