import type { FastifyInstance } from "fastify";
import { checkBackends } from "@kesher/agent";
import { isLocalRequest } from "../auth.js";

/**
 * Web search diagnostic: one query on each search backend (DuckDuckGo, DuckDuckGo Lite, Mojeek, Bing), with how
 * many results it gave, how long it took and why it failed. JSON only, only on this computer.
 *
 * @param app - Fastify instance.
 */
export async function webSearchCheckRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string } }>("/api/web/search-check", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only available on this computer" });
    const q = String(req.query?.q ?? "").trim().slice(0, 200) || "typescript documentation";
    return checkBackends(q, AbortSignal.timeout(60_000));
  });
}
