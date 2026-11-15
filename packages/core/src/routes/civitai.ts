import type { FastifyInstance } from "fastify";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KesherServices } from "../services.js";
import { searchLoras, versionForDownload } from "../civitai.js";
import { isLocalRequest } from "../auth.js";

/** Where a LoRA's CivitAI details (trigger words, base model) are kept, next to its file. */
const sidecar = (dir: string, name: string) => join(dir, `${name}.civitai.json`);

/**
 * LoRAs from CivitAI (audit F5): search, download into the LoRA folder with their trigger words, and the trigger
 * words of LoRAs already here. The user's CivitAI key is optional (some LoRAs need one to download).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function civitaiRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const token = () => s.config.civitai?.token || undefined;

  app.get<{ Querystring: { q?: string; nsfw?: string; base?: string } }>("/api/civitai/loras", async (req, reply) => {
    try {
      return { loras: await searchLoras(String(req.query.q ?? ""), { nsfw: req.query.nsfw === "1", ...(req.query.base ? { baseModel: String(req.query.base).slice(0, 40) } : {}), ...(token() ? { token: token()! } : {}) }, AbortSignal.timeout(25_000)) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** A preview picture, through KesherAI (the app only loads pictures from itself); only from CivitAI's image host. */
  app.get<{ Querystring: { url?: string } }>("/api/civitai/image", async (req, reply) => {
    let url: URL;
    try {
      url = new URL(String(req.query.url ?? ""));
    } catch {
      return reply.code(400).send({ error: "Not an address." });
    }
    if (url.protocol !== "https:" || url.hostname !== "image.civitai.com") return reply.code(400).send({ error: "Only CivitAI's pictures." });
    // A small preview is enough: CivitAI resizes on its side when asked for a width.
    const small = url.href.replace(/\/(original=true|width=\d+)\//, "/width=320/");
    const res = await fetch(small, { headers: { "user-agent": "KesherAI" }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    const type = res?.headers.get("content-type") ?? "";
    if (!res?.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) return reply.code(502).send({ error: "The picture did not load." });
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > 3 * 1024 * 1024) return reply.code(502).send({ error: "The picture is too big." });
    return reply.type(type).header("cache-control", "max-age=86400").send(body);
  });

  app.post<{ Body: { versionId?: number } }>("/api/civitai/download", async (req, reply) => {
    const versionId = Number(req.body?.versionId);
    if (!Number.isInteger(versionId) || versionId <= 0) return reply.code(400).send({ error: "Which LoRA?" });
    try {
      // Everything about the file comes from CivitAI again, never from the page.
      const v = await versionForDownload(versionId, token(), AbortSignal.timeout(25_000));
      const dest = join(s.sd.loraDir, v.fileName);
      const name = v.fileName.replace(/\.safetensors$/i, "");
      await mkdir(s.sd.loraDir, { recursive: true });
      await writeFile(sidecar(s.sd.loraDir, name), JSON.stringify({ name: v.name, versionId, ...(v.modelId ? { modelId: v.modelId } : {}), ...(v.baseModel ? { baseModel: v.baseModel } : {}), triggers: v.triggers }, null, 2));
      const job = s.downloads.enqueue({
        url: v.url,
        dest,
        ...(v.sizeBytes ? { size: v.sizeBytes } : {}),
        ...(v.sha256 ? { sha256: v.sha256 } : {}),
        ...(token() ? { headers: { authorization: `Bearer ${token()}` } } : {}),
        label: `CivitAI · ${v.name}`,
      });
      return { job, name, triggers: v.triggers };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** The trigger words of the LoRAs here that came from CivitAI, by LoRA name. */
  app.get("/api/civitai/triggers", async () => {
    const out: Record<string, { triggers: string[]; baseModel?: string }> = {};
    for (const l of await s.sd.loras()) {
      const j = await readFile(sidecar(s.sd.loraDir, l.name), "utf8").then((t) => JSON.parse(t) as { triggers?: unknown; baseModel?: unknown }, () => undefined);
      if (j && Array.isArray(j.triggers)) out[l.name] = { triggers: j.triggers.map(String).slice(0, 12), ...(typeof j.baseModel === "string" ? { baseModel: j.baseModel } : {}) };
    }
    return out;
  });

  /** The user's CivitAI key: set from this computer only; never sent back. */
  app.get("/api/civitai/key", async () => ({ set: !!token() }));
  app.put<{ Body: { token?: string } }>("/api/civitai/key", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Set the key on the computer itself." });
    const t = String(req.body?.token ?? "").trim().slice(0, 200);
    s.config.civitai = t ? { token: t } : {};
    await s.saveConfig();
    return { set: !!t };
  });

  // A LoRA removed from the folder takes its CivitAI details with it.
  app.addHook("onResponse", async (req, reply) => {
    const m = /^\/api\/loras\/([^/?]+)$/.exec(req.url);
    if (req.method === "DELETE" && m && reply.statusCode === 200) await rm(sidecar(s.sd.loraDir, decodeURIComponent(m[1]!)), { force: true }).catch(() => undefined);
  });
}
