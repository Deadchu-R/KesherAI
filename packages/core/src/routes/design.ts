import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BOARD_NAME, findDesignRepo, OUT_DIR, readDesignOut, renderDesign, setBoardNote } from "../design-render.js";
import type { KesherServices } from "../services.js";

type Name = { Params: { name: string } };

/**
 * The Design page (#/design): the design-doc boards KesherAI renders itself (design-render.ts), "Render again", and
 * Roee's note per board. Works from the phone too: the pictures come through this server. One render at a time.
 */
export async function designRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const repo = () => findDesignRepo([s.config.taskInbox?.repo]);
  const out = () => {
    const r = repo();
    return r ? join(r, OUT_DIR) : undefined;
  };
  let running: { since: string; step: string } | undefined;
  let lastError = "";

  app.get("/api/design", async () => {
    const o = out();
    if (!o) return { available: false, boards: [], baseVersion: "", running: null, error: "" };
    return { available: true, ...(await readDesignOut(o)), running: running ?? null, error: lastError };
  });

  app.post<{ Body: { boards?: string[] } | null }>("/api/design/render", async (req, reply) => {
    const r = repo();
    if (!r) return reply.code(404).send({ error: "No KesherAI source folder with tools/design/scenarios (Settings > Task inbox > folder)." });
    if (running) return reply.code(409).send({ error: "A render is already running." });
    const only = Array.isArray(req.body?.boards) ? req.body.boards.filter((b) => typeof b === "string" && /^[A-Za-z][A-Za-z0-9-]{0,70}(\.dc\.html)?$/.test(b)).slice(0, 100) : undefined;
    running = { since: new Date().toISOString(), step: "" };
    lastError = "";
    void renderDesign({ repo: r, ...(only?.length ? { only } : {}), log: (step) => { if (running) running.step = step; } })
      .catch((e: unknown) => { lastError = (e as Error).message; })
      .finally(() => { running = undefined; });
    return reply.code(202).send({ started: true });
  });

  app.get<Name>("/api/design/shot/:name", async (req, reply) => {
    const o = out();
    if (!o || !BOARD_NAME.test(req.params.name)) return reply.code(404).send({ error: "not found" });
    const png = await readFile(join(o, "shots", req.params.name.replace(/\.dc\.html$/, ".png"))).catch(() => undefined);
    if (!png) return reply.code(404).send({ error: "not found" });
    // The page asks with ?v=<hash>, so a picture may be kept until it changes.
    return reply.type("image/png").header("cache-control", "private, max-age=86400").send(png);
  });

  app.put<Name & { Body: { note?: string } }>("/api/design/note/:name", async (req, reply) => {
    const o = out();
    if (!o || !BOARD_NAME.test(req.params.name)) return reply.code(404).send({ error: "not found" });
    await setBoardNote(o, req.params.name, String(req.body?.note ?? ""));
    return { ok: true };
  });
}
