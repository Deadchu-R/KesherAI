import type { FastifyInstance } from "fastify";
import { checkBackends, setSearchKeys } from "@kesher/agent";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";

/**
 * Web search diagnostic: one query on each search backend (Tavily and Brave when a key is set, DuckDuckGo, Lite, Yahoo,
 * Startpage, Mojeek, Ecosia, Bing), with how many results it gave, how many of them match the query, how long it took and why it failed. JSON only, only on this computer.
 *
 * Also Settings > Web's optional free keys (Tavily, Brave Search): GET says only whether each is set, PUT (this computer only)
 * sets or clears one; a key is never sent back or logged.
 *
 * @param app - Fastify instance.
 * @param s - The services (the config).
 */
export async function webSearchCheckRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  // The search reads the user's keys from the config on every search, so a changed key applies at once.
  setSearchKeys(() => s.config.webKeys);

  app.get<{ Querystring: { q?: string } }>("/api/web/search-check", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only available on this computer" });
    const q = String(req.query?.q ?? "").trim().slice(0, 200) || "typescript documentation";
    return checkBackends(q, AbortSignal.timeout(60_000));
  });

  app.get("/api/web-keys", async () => ({ tavily: !!s.config.webKeys?.tavily, brave: !!s.config.webKeys?.brave }));
  app.put<{ Body: { tavily?: string | null; brave?: string | null } }>("/api/web-keys", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Search keys are changed on the computer that runs KesherAI." });
    const next: { tavily?: string; brave?: string } = { ...s.config.webKeys };
    for (const name of ["tavily", "brave"] as const) {
      const v = req.body?.[name];
      if (v === undefined) continue;
      const key = typeof v === "string" ? v.trim() : "";
      if (key && (key.length > 200 || /\s/.test(key))) return reply.code(400).send({ error: "That does not look like a key." });
      if (key) next[name] = key;
      else delete next[name];
    }
    s.config.webKeys = next;
    await s.saveConfig();
    return { tavily: !!next.tavily, brave: !!next.brave };
  });
}
