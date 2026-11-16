import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { modelTurnFor } from "../model-turn.js";
import type { ApiKeys } from "../api-keys.js";
import type { KesherServices } from "../services.js";
import { STREMIO_MANIFEST, StremioTaste } from "../stremio.js";

/**
 * Stremio: her taste (a Letterboxd export, ratings in KesherAI), recommendations by the chat model, and the addon
 * Stremio installs (manifest and catalogs at /stremio/<app key>/…; the key is one of KesherAI's revocable app keys,
 * since Stremio cannot send a header).
 */
export async function stremioRoutes(app: FastifyInstance, s: KesherServices, keys: ApiKeys): Promise<void> {
  const taste = new StremioTaste(join(s.paths.root, "stremio"));
  const ask = async (system: string, user: string) => {
    const id = s.config.activeModels.chat;
    if (!id) throw Object.assign(new Error("Choose a chat model first (Models page)."), { statusCode: 409 });
    const r = await modelTurnFor(s.registry, id)({ messages: [{ role: "system", content: system }, { role: "user", content: user }], tools: [] }, AbortSignal.timeout(300_000), () => undefined);
    return r.text;
  };
  app.get("/api/stremio", async () => {
    const t = await taste.load();
    return { rated: t.rated.length, letterboxd: t.rated.filter((r) => r.from === "letterboxd").length, mine: t.rated.filter((r) => r.from === "kesher").slice(0, 50), picks: t.picks };
  });
  app.post<{ Body: { csv?: string } }>("/api/stremio/letterboxd", { bodyLimit: 20 * 1024 * 1024 }, async (req) => taste.importLetterboxd(String(req.body?.csv ?? "")));
  app.post<{ Body: { title?: string; rating?: number; kind?: "movie" | "series"; year?: number } }>("/api/stremio/rate", async (req) => ({ rated: (await taste.rate(String(req.body?.title ?? ""), Number(req.body?.rating ?? 0), req.body?.kind === "series" ? "series" : "movie", typeof req.body?.year === "number" ? req.body.year : undefined)).length }));
  app.post("/api/stremio/refresh", async () => taste.refresh(ask));
  // Posters through KesherAI (the page loads pictures only from itself): only the stored picks' Cinemeta posters.
  app.get<{ Params: { id: string } }>("/api/stremio/poster/:id", async (req, reply) => {
    const t = await taste.load();
    const p = [...t.picks.movie, ...t.picks.series].find((x) => x.id === req.params.id);
    if (!p?.poster || !/^https:\/\/(images\.metahub\.space|m\.media-amazon\.com|image\.tmdb\.org)\//.test(p.poster)) return reply.code(404).send({ error: "No poster." });
    const r = await fetch(p.poster, { redirect: "error", signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    const type = r?.headers.get("content-type") ?? "";
    if (!r?.ok || !/^image\/(jpeg|png|webp)/.test(type)) return reply.code(404).send({ error: "No poster." });
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > 2 * 1024 * 1024) return reply.code(404).send({ error: "No poster." });
    return reply.type(type).header("cache-control", "private, max-age=86400").send(body);
  });
  // The addon itself (no KesherAI sign-in: the app key in the address is the check; revoking it ends the addon).
  const ok = (key: string) => !!keys.verify(key);
  const cors = { "access-control-allow-origin": "*" };
  app.get<{ Params: { key: string } }>("/stremio/:key/manifest.json", async (req, reply) => (ok(req.params.key) ? reply.headers(cors).send(STREMIO_MANIFEST) : reply.code(404).send({ error: "Unknown addon address." })));
  app.get<{ Params: { key: string; type: string; id: string } }>("/stremio/:key/catalog/:type/:id.json", async (req, reply) => {
    if (!ok(req.params.key)) return reply.code(404).send({ error: "Unknown addon address." });
    const t = await taste.load();
    const list = req.params.type === "series" ? t.picks.series : req.params.type === "movie" ? t.picks.movie : [];
    return reply.headers(cors).send({ metas: list.map((p) => ({ id: p.id, type: p.type, name: p.name, ...(p.poster ? { poster: p.poster } : {}), ...(p.year ? { releaseInfo: p.year } : {}), ...(p.why ? { description: p.why } : {}) })) });
  });
}
