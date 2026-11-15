/**
 * Share links (shares.ts): the owner shares a chat, updates or revokes the share and sees the list; anyone with the
 * link reads the page at /s/<token> (outside /api, so it needs no other key: the token is the key).
 */
import type { FastifyInstance } from "fastify";
import { sharePage, SHARE_HEADERS, snapshotOf, type ChatEvent, type ShareStore } from "../shares.js";

/**
 * Routes for share links.
 *
 * @param app - Fastify instance.
 * @param store - The shares.
 * @param readChat - A chat's title and events, or undefined when there is no such chat (or it is incognito).
 */
export async function shareRoutes(app: FastifyInstance, store: ShareStore, readChat: (convId: string) => Promise<{ title: string; events: readonly ChatEvent[] } | undefined>): Promise<void> {
  app.get("/api/shares", async () => ({ shares: (await store.list()).map(({ token, ...s }) => ({ ...s, path: `/s/${token}` })) }));

  app.get<{ Params: { id: string } }>("/api/conversations/:id/share", async (req) => {
    const s = await store.ofChat(req.params.id);
    if (!s) return { share: null };
    const { token, ...rest } = s;
    return { share: { ...rest, path: `/s/${token}` } };
  });

  /** Shares the chat as it is now, or updates its share (same link). */
  app.post<{ Params: { id: string }; Body: { days?: number; lang?: string } }>("/api/conversations/:id/share", async (req, reply) => {
    const chat = await readChat(req.params.id);
    if (!chat) return reply.code(404).send({ error: "This chat cannot be shared." });
    const days = [0, 1, 7, 30].includes(Number(req.body?.days)) ? Number(req.body?.days) : 7;
    try {
      const s = await store.share(req.params.id, chat.title, snapshotOf(chat.events), days, Date.now(), req.body?.lang === "he" ? "he" : "en");
      return { share: { id: s.id, title: s.title, messages: s.messages.length, expiresAt: s.expiresAt, views: s.views, path: `/s/${s.token}` } };
    } catch (err) {
      const e = err as Error & { code?: number };
      return reply.code(e.code === 400 ? 400 : 500).send({ error: e.message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/shares/:id", async (req, reply) => ((await store.revoke(req.params.id)) ? { ok: true } : reply.code(404).send({ error: "No such share." })));

  /** The shared page itself. */
  app.get<{ Params: { token: string } }>("/s/:token", async (req, reply) => {
    const s = await store.open(req.params.token);
    return reply.code(s ? 200 : 404).headers(SHARE_HEADERS).send(sharePage(s));
  });
}
