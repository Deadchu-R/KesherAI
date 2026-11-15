/**
 * Canvases (canvas.ts): the list, one canvas, saving what the open page drew, and a live stream so the open page
 * follows the model's drawing.
 */
import type { FastifyInstance } from "fastify";
import type { CanvasStore } from "../canvas.js";
import { startSSE } from "../sse.js";

const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) => {
  const e = err as Error & { code?: number };
  return reply.code(typeof e.code === "number" && e.code >= 400 && e.code < 500 ? e.code : 500).send({ error: e.message });
};

/**
 * Routes for canvases.
 *
 * @param app - Fastify instance.
 * @param store - The canvases.
 * @param chatTitle - A chat's title (for a chat's new canvas), or undefined when there is no such chat.
 */
export async function canvasRoutes(app: FastifyInstance, store: CanvasStore, chatTitle: (convId: string) => string | undefined): Promise<void> {
  app.get("/api/canvases", async () => ({ canvases: await store.list() }));

  app.post<{ Body: { title?: string } }>("/api/canvases", async (req) => store.create(String(req.body?.title ?? "Canvas")));

  /** A chat's own canvas, made the first time it is opened. */
  app.post<{ Params: { id: string } }>("/api/conversations/:id/canvas", async (req, reply) => {
    const title = chatTitle(req.params.id);
    if (title === undefined) return reply.code(404).send({ error: "Conversation not found" });
    try {
      return await store.create(title || "Canvas", req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/canvases/:id", async (req, reply) => {
    try {
      return (await store.get(req.params.id)) ?? reply.code(404).send({ error: "No such canvas." });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: { elements?: unknown; rev?: number; drawn?: string[]; title?: string } }>("/api/canvases/:id", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    try {
      const b = req.body ?? {};
      if (typeof b.title === "string" && b.elements === undefined) return await store.rename(req.params.id, b.title);
      const drawn = Array.isArray(b.drawn) ? b.drawn.filter((x): x is string => typeof x === "string").slice(0, 1000) : [];
      return await store.save(req.params.id, b.elements, Number(b.rev), drawn);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/canvases/:id", async (req, reply) => {
    try {
      await store.remove(req.params.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Each change's revision, for the open page (it fetches the canvas and merges). */
  app.get<{ Params: { id: string } }>("/api/canvases/:id/events", async (req, reply) => {
    const doc = await store.get(req.params.id).catch(() => undefined);
    if (!doc) return reply.code(404).send({ error: "No such canvas." });
    const sse = startSSE(req, reply);
    sse.send({ rev: doc.rev });
    const on = (rev: number) => sse.send({ rev });
    store.on(`change:${doc.id}`, on);
    const ping = setInterval(() => sse.send({ ping: true }), 10_000);
    sse.closed.addEventListener("abort", () => {
      clearInterval(ping);
      store.off(`change:${doc.id}`, on);
    });
  });
}
