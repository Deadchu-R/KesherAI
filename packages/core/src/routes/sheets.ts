import type { FastifyInstance } from "fastify";
import { startSSE } from "../sse.js";
import type { SheetStore } from "../sheets.js";
import { csvCells } from "@kesher/shared";

type P = { Params: { id: string } };

/**
 * Sheets (design SheetEditor): the list, one sheet, saving the cells the open page changed, CSV in, versions, and a
 * live stream so the open page follows the model's edits.
 *
 * @param app - Fastify instance.
 * @param store - The sheets.
 */
export async function sheetRoutes(app: FastifyInstance, store: SheetStore): Promise<void> {
  app.get("/api/sheets", async () => ({ sheets: await store.list() }));
  /** A new sheet: `{ title, cells? }` or `{ title, csv }` (a CSV she opened). */
  app.post<{ Body: { title?: string; cells?: unknown; csv?: string } }>("/api/sheets", { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const b = req.body ?? {};
    return store.create({ title: String(b.title ?? "Sheet"), cells: typeof b.csv === "string" ? csvCells(b.csv.slice(0, 6_000_000)) : b.cells });
  });
  app.get<P>("/api/sheets/:id", async (req, reply) => (await store.get(req.params.id)) ?? reply.code(404).send({ error: "No such sheet." }));
  app.put<P & { Body: { title?: unknown; changes?: unknown; cols?: unknown; rows?: unknown; rev?: number } }>("/api/sheets/:id", { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const b = req.body ?? {};
    return store.save(req.params.id, { title: b.title, changes: b.changes, cols: b.cols, rows: b.rows, rev: Number(b.rev) });
  });
  app.post<P & { Body: { rev?: number } }>("/api/sheets/:id/restore", async (req) => store.restore(req.params.id, Number(req.body?.rev)));
  app.delete<P>("/api/sheets/:id", async (req) => {
    await store.remove(req.params.id);
    return { ok: true };
  });
  /** Each change's revision, for the open page (it loads the sheet again). */
  app.get<P>("/api/sheets/:id/events", async (req, reply) => {
    const d = await store.get(req.params.id).catch(() => undefined);
    if (!d) return reply.code(404).send({ error: "No such sheet." });
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
