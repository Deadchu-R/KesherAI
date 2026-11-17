import type { FastifyInstance } from "fastify";
import { startSSE } from "../sse.js";
import type { DocStore } from "../docs.js";
import type { KesherServices } from "../services.js";
import { pagePrompt } from "../pages.js";
import { modelTurnFor } from "../conversations.js";

type P = { Params: { id: string } };

/**
 * Documents (design DocEditor): the list, one document, saving the open page's text, versions, and a live stream so
 * the open page follows the model's edits.
 *
 * @param app - Fastify instance.
 * @param store - The documents.
 * @param s - The services (the chat model, for the writing buttons).
 */
export async function docRoutes(app: FastifyInstance, store: DocStore, s?: KesherServices): Promise<void> {
  app.get("/api/docs", async () => ({ docs: await store.list() }));
  app.post<{ Body: { title?: string; body?: string } }>("/api/docs", { bodyLimit: 4 * 1024 * 1024 }, async (req) => store.create({ title: String(req.body?.title ?? "Document"), body: String(req.body?.body ?? "") }));
  app.get<P>("/api/docs/:id", async (req, reply) => (await store.get(req.params.id)) ?? reply.code(404).send({ error: "No such document." }));
  app.put<P & { Body: { title?: unknown; body?: unknown; rev?: number } }>("/api/docs/:id", { bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const b = req.body ?? {};
    return store.save(req.params.id, { title: b.title, body: b.body, rev: Number(b.rev) });
  });
  app.post<P & { Body: { rev?: number } }>("/api/docs/:id/restore", async (req) => store.restore(req.params.id, Number(req.body?.rev)));
  app.delete<P>("/api/docs/:id", async (req) => {
    await store.remove(req.params.id);
    return { ok: true };
  });
  /**
   * A writing button or request on part of the document (rewrite, shorter, fix, translate, or her own words).
   * Body: `{ action?, instruction?, selection, content? }`. Answers `{ text }`: what replaces the selection.
   */
  app.post<P & { Body: { action?: string; instruction?: string; selection?: string; content?: string } }>("/api/docs/:id/write", { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const d = await store.get(req.params.id);
    if (!d) return reply.code(404).send({ error: "No such document." });
    const chat = s?.config.activeModels.chat;
    if (!s || !chat) return reply.code(400).send({ error: "Choose a chat model first; it writes with you." });
    const b = req.body ?? {};
    if (!b.action && !b.instruction?.trim()) return reply.code(400).send({ error: "Say what to write." });
    const ac = new AbortController();
    reply.raw.on("close", () => !reply.raw.writableFinished && ac.abort());
    try {
      const r = await modelTurnFor(s.registry, chat)({ messages: pagePrompt({ title: d.title, content: typeof b.content === "string" ? b.content : d.body }, { ...(b.action ? { action: b.action } : {}), ...(b.instruction ? { instruction: b.instruction } : {}), ...(b.selection ? { selection: b.selection } : {}) }), tools: [] }, ac.signal, () => undefined);
      return { text: r.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/, "$1").trim() };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
  /** Each change's revision, for the open page (it loads the document again). */
  app.get<P>("/api/docs/:id/events", async (req, reply) => {
    const d = await store.get(req.params.id).catch(() => undefined);
    if (!d) return reply.code(404).send({ error: "No such document." });
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
