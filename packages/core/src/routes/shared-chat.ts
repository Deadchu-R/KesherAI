/**
 * A shared chat with replies (shared-chat.ts): the owner's settings and moderation, and the guest's live view, typing
 * beats and messages. Guests reach only `/api/guest/*` (auth.ts), with the key of the project they were invited to
 * (guests.ts); every guest route here checks that the chat is in that project and that its share allows it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentEvent } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { GuestQuota, guestOf } from "../guests.js";
import { pairedDeviceIdOf } from "../request-origin.js";
import { cleanForShare, type ShareStore } from "../shares.js";
import { canReply, ChatLive, DENIAL_TEXT, guestLabelOf, guestMessage, REMOVED, ReplyLimit, repliesEnded, updateReplies } from "../shared-chat.js";

/**
 * Routes for replies in shared chats.
 *
 * @param app - Fastify instance.
 * @param s - KesherAI's services.
 * @param store - The shares (the same store the share links use).
 */
export async function sharedChatRoutes(app: FastifyInstance, s: KesherServices, store: ShareStore): Promise<void> {
  const live = new ChatLive();
  const limit = new ReplyLimit();
  const quota = (s.guestQuota ??= new GuestQuota());
  /** Sessions already followed for the answer being written. */
  const followed = new WeakSet<object>();

  /** A chat's session, followed so guests see the answer as it is written. */
  const openChat = async (id: string) => {
    const opened = await s.conversations.open(id);
    if (opened && !followed.has(opened.session)) {
      followed.add(opened.session);
      opened.session.on("event", (e: AgentEvent) => live.see(id, e as { type: string; text?: string; status?: string }));
    }
    return opened;
  };

  /** The guest behind a request (their key's project and role), or undefined. */
  const guestBehind = (req: FastifyRequest) => {
    const id = pairedDeviceIdOf(req);
    const d = id ? s.config.remote.devices.find((x) => x.id === id) : undefined;
    const g = guestOf(d?.scope);
    return d && g && s.library.getProject(g.projectId) ? { id: d.id, name: d.name.replace(/ \(guest\)$/, ""), ...g } : undefined;
  };
  /** An owner's chat a guest asks about: in the guest's project, a chat, not one of the guests' own. */
  const chatFor = (g: { projectId: string }, id: string) => {
    const c = s.library.summary(id);
    return c && c.projectId === g.projectId && c.kind === "chat" && c.source !== "guest" && !c.incognito ? c : undefined;
  };
  const refuse = (reply: FastifyReply) => reply.code(403).send({ error: "Only a guest of a shared project can use this." });
  const lang = (req: FastifyRequest) => (String(req.headers["accept-language"] ?? "").startsWith("he") ? "he" : "en");

  // ---- The owner's (a guest key cannot reach these). ----

  /** Turns replies on or off, and sets how long, tools and messages a minute: `{ on, hours, tools, perMinute }`. */
  app.put<{ Params: { id: string }; Body: { on?: unknown; hours?: unknown; tools?: unknown; perMinute?: unknown } }>("/api/conversations/:id/share/replies", { bodyLimit: 2048 }, async (req, reply) => {
    const c = s.library.summary(req.params.id);
    if (!c) return reply.code(404).send({ error: "No such chat." });
    if ((req.body?.on === true) && !c.projectId) return reply.code(400).send({ error: "Put this chat in a project and invite people to it first: only the project's guests can reply." });
    const r = await store.setReplies(req.params.id, (old, share) => updateReplies(old, req.body ?? {}, share.expiresAt, Date.now()));
    if (!r) return reply.code(404).send({ error: "Share this chat first." });
    if ("error" in r) return reply.code(400).send(r);
    return { replies: r };
  });

  /** The room as the owner sees it: settings, the project's guests (typing, muted), and the guests' messages. */
  app.get<{ Params: { id: string } }>("/api/conversations/:id/share/room", async (req, reply) => {
    const c = s.library.summary(req.params.id);
    if (!c) return reply.code(404).send({ error: "No such chat." });
    const share = await store.live(c.id);
    const project = c.projectId ? s.library.getProject(c.projectId) : undefined;
    const typing = new Set(live.typingIn(c.id));
    const muted = share?.replies?.muted ?? [];
    const guests = project
      ? s.config.remote.devices.filter((d) => guestOf(d.scope)?.projectId === project.id).map((d) => {
          const name = d.name.replace(/ \(guest\)$/, "");
          return { id: d.id, name, role: guestOf(d.scope)!.role, muted: muted.includes(d.id), typing: typing.has(name), lastSeen: d.lastSeen ?? null };
        })
      : [];
    const opened = await openChat(c.id);
    const messages = (opened?.session.events ?? []).flatMap((e) => {
      const g = e.type === "user" ? guestLabelOf(e.text) : undefined;
      return g && g.text !== REMOVED ? [{ seq: e.seq, name: g.name, text: g.text.slice(0, 400), at: e.at }] : [];
    });
    return { project: project ? { id: project.id, name: project.name } : null, replies: share?.replies ?? null, ended: share ? repliesEnded(share, Date.now()) : false, guests, messages: messages.slice(-30).reverse() };
  });

  /** Mutes or unmutes a guest in this chat: `{ guest, muted }`. */
  app.post<{ Params: { id: string }; Body: { guest?: unknown; muted?: unknown } }>("/api/conversations/:id/share/mute", { bodyLimit: 1024 }, async (req, reply) => {
    const guest = String(req.body?.guest ?? "");
    if (!s.config.remote.devices.some((d) => d.id === guest && guestOf(d.scope))) return reply.code(404).send({ error: "No such guest." });
    const r = await store.setReplies(req.params.id, (old) => {
      const set = new Set(old?.muted ?? []);
      if (req.body?.muted === false) set.delete(guest);
      else set.add(guest);
      return { ...(old ?? { on: false, until: null, tools: false, perMinute: 6 }), muted: [...set].slice(-200) };
    });
    if (!r) return reply.code(404).send({ error: "Share this chat first." });
    live.stop(req.params.id, guest);
    return r;
  });

  /** Deletes a guest's message (its words become "removed by the owner" for everyone, the model too). */
  app.delete<{ Params: { id: string; seq: string } }>("/api/conversations/:id/guest-messages/:seq", async (req, reply) => {
    const ok = await s.conversations.removeGuestMessage(req.params.id, Number(req.params.seq));
    return ok ? { ok: true } : reply.code(404).send({ error: "No such guest message." });
  });

  // ---- The guest's. ----

  /**
   * The chat live, after the message numbered `after`: new messages (who wrote each), the answer being written,
   * who is typing, and whether this guest may write. Asked about once a second and a half while the chat is open.
   */
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/guest/chats/:id/live", async (req, reply) => {
    const g = guestBehind(req);
    if (!g) return refuse(reply);
    const c = chatFor(g, req.params.id);
    if (!c) return reply.code(404).send({ error: "No such chat in this project." });
    const opened = await openChat(c.id);
    if (!opened) return reply.code(404).send({ error: "No such chat in this project." });
    const after = Math.max(0, Number(req.query.after) || 0);
    const messages = opened.session.events
      .filter((e): e is Extract<AgentEvent, { type: "user" | "assistant" }> => (e.type === "user" || e.type === "assistant") && e.seq > after)
      .slice(-200)
      .map((e) => {
        const label = e.type === "user" ? guestLabelOf(e.text) : undefined;
        return { seq: e.seq, role: e.type, from: e.type === "assistant" ? "ai" : label ? label.name : "owner", guest: !!label, text: cleanForShare((label ? label.text : e.text).slice(0, 40_000)) };
      });
    const share = await store.live(c.id);
    const may = canReply({ share, guest: g, chatProjectId: c.projectId, now: Date.now() });
    const busy = opened.session.info().status !== "idle" && opened.session.info().status !== "error";
    return {
      id: c.id,
      title: c.title,
      busy,
      messages,
      // The answer being written: text only (approvals, questions and tool steps never come here).
      writing: busy ? cleanForShare(live.writingIn(c.id)) : "",
      typing: live.typingIn(c.id, g.id),
      replies: may.ok ? { canSend: true, tools: !!share?.replies?.tools, perMinute: share?.replies?.perMinute ?? 6 } : { canSend: false, why: DENIAL_TEXT[may.why] },
    };
  });

  /** A typing beat (at most one a second; only for a guest who may write here). */
  app.post<{ Params: { id: string } }>("/api/guest/chats/:id/typing", { bodyLimit: 256 }, async (req, reply) => {
    const g = guestBehind(req);
    if (!g) return refuse(reply);
    const c = chatFor(g, req.params.id);
    if (!c) return reply.code(404).send({ error: "No such chat in this project." });
    if (!canReply({ share: await store.live(c.id), guest: g, chatProjectId: c.projectId, now: Date.now() }).ok) return reply.code(403).send({ error: "You cannot write in this chat." });
    if (!live.beat(c.id, g.id, g.name)) return reply.code(429).send({ error: "At most one a second." });
    return { ok: true };
  });

  /** A guest's message in the owner's chat: checked, limited, labelled, and run under the owner's rules (shared-chat.ts). */
  app.post<{ Params: { id: string }; Body: { text?: string } }>("/api/guest/chats/:id/reply", { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const g = guestBehind(req);
    if (!g) return refuse(reply);
    const c = chatFor(g, req.params.id);
    if (!c) return reply.code(404).send({ error: "No such chat in this project." });
    const share = await store.live(c.id);
    const may = canReply({ share, guest: g, chatProjectId: c.projectId, now: Date.now() });
    if (!may.ok) return reply.code(403).send({ error: DENIAL_TEXT[may.why][lang(req)] });
    const text = guestMessage(g.name, String(req.body?.text ?? ""));
    if (!text) return reply.code(400).send({ error: "Empty message" });
    const wait = limit.take(g.id, share!.replies!.perMinute);
    if (wait) return reply.code(429).send({ error: lang(req) === "he" ? `לאט יותר: אפשר לשלוח שוב בעוד ${wait} שניות.` : `Slow down: you can send again in ${wait} seconds.` });
    const left = quota.take(g.id, s.config.remote.guestDailyLimit);
    if (left < 0) return reply.code(429).send({ error: lang(req) === "he" ? "נגמרו התשובות להיום. מחר יהיו עוד." : `That is today's ${s.config.remote.guestDailyLimit} answers. More tomorrow.` });
    live.stop(c.id, g.id);
    await openChat(c.id);
    try {
      const r = await s.conversations.send(c.id, text, { guest: { name: g.name, tools: !!share!.replies!.tools } });
      return { ok: true, left, ...(r.queued ? { queued: r.queued } : {}) };
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });
}
