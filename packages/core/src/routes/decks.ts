import type { FastifyInstance } from "fastify";
import { startSSE } from "../sse.js";
import type { DeckStore } from "../decks.js";

type P = { Params: { id: string } };

/**
 * Slide decks (design DeckEditor): the list, one deck, saving the open page's deck, versions, and a live stream so
 * the open page follows the model's edits.
 *
 * @param app - Fastify instance.
 * @param store - The decks.
 */
export async function deckRoutes(app: FastifyInstance, store: DeckStore): Promise<void> {
  app.get("/api/decks", async () => ({ decks: await store.list() }));
  app.post<{ Body: { title?: string; slides?: unknown[]; theme?: string } }>("/api/decks", { bodyLimit: 20 * 1024 * 1024 }, async (req) => store.create({ title: String(req.body?.title ?? "Slides"), ...(Array.isArray(req.body?.slides) ? { slides: req.body.slides } : {}), ...(typeof req.body?.theme === "string" ? { theme: req.body.theme } : {}) }));
  app.get<P>("/api/decks/:id", async (req, reply) => (await store.get(req.params.id)) ?? reply.code(404).send({ error: "No such deck." }));
  app.put<P & { Body: { title?: unknown; theme?: unknown; slides?: unknown; rev?: number } }>("/api/decks/:id", { bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const b = req.body ?? {};
    return store.save(req.params.id, { title: b.title, theme: b.theme, slides: b.slides, rev: Number(b.rev) });
  });
  app.post<P & { Body: { rev?: number } }>("/api/decks/:id/restore", async (req) => store.restore(req.params.id, Number(req.body?.rev)));
  app.delete<P>("/api/decks/:id", async (req) => {
    await store.remove(req.params.id);
    return { ok: true };
  });
  /** Each change's revision, for the open page (it loads the deck again). */
  app.get<P>("/api/decks/:id/events", async (req, reply) => {
    const d = await store.get(req.params.id).catch(() => undefined);
    if (!d) return reply.code(404).send({ error: "No such deck." });
    const sse = startSSE(req, reply);
    sse.send({ rev: d.rev });
    const on = (rev: number) => sse.send({ rev });
    store.on(`change:${d.id}`, on);
    const ping = setInterval(() => sse.send({ ping: true }), 10_000);
    sse.closed.addEventListener("abort", () => {
      clearInterval(ping);
      store.off(`change:${d.id}`, on);
    });
  });
}
