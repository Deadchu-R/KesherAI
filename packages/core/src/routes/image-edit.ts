import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { imageSize, resizeImage, versionMeta, type SharpLoader } from "../image-ops.js";

/** Tests put a fake `sharp` here; nothing else touches it. */
export const imageEdit: { sharp?: SharpLoader } = {};

const ID = /^[0-9a-f-]{36}$/;
/** The biggest picture a version may be saved from (a phone crop or a PC resize is far below). */
const MAX_BYTES = 40 * 1024 * 1024;

/**
 * The image surface's server side (ImagePanel.tsx). Every edit saves a NEW asset that remembers its parent (versions
 * live on the server, the original is never changed): `GET /api/images/:id/info` (size, model, prompt, version),
 * `POST /api/images/resize` (through `sharp` when it is installed; 200 with `via: "canvas"` and no asset when it is
 * not, so the panel resizes itself) and `POST /api/images/version` (without `parent`: a chat file brought in as the first version; else the panel's own crop or rotation or an inpaint
 * result, as a data address). From the phone these go through the usual device key.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function imageEditRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/images/:id/info", async (req, reply) => {
    const found = ID.test(req.params.id) ? await s.assets.get(req.params.id) : undefined;
    if (!found || found.asset.kind !== "image") return reply.code(404).send({ error: "Picture not found" });
    const { asset, data } = found;
    const m = asset.meta ?? {};
    return {
      id: asset.id,
      mimeType: asset.mimeType,
      bytes: data.length,
      ...(imageSize(data) ?? {}),
      ...(asset.sourceModelId ? { model: asset.sourceModelId } : {}),
      ...(typeof m.prompt === "string" ? { prompt: m.prompt } : {}),
      version: typeof m.version === "number" ? m.version : 1,
      ...(typeof m.parent === "string" ? { parent: m.parent } : {}),
    };
  });

  app.post<{ Body: { id?: string; width?: number; height?: number; keep?: boolean } }>("/api/images/resize", async (req, reply) => {
    const b = req.body ?? {};
    const found = typeof b.id === "string" && ID.test(b.id) ? await s.assets.get(b.id) : undefined;
    if (!found || found.asset.kind !== "image") return reply.code(404).send({ error: "Picture not found" });
    try {
      const r = await resizeImage(found.data, { ...(b.width !== undefined ? { width: b.width } : {}), ...(b.height !== undefined ? { height: b.height } : {}), keep: b.keep === true }, imageEdit.sharp);
      if (!r) return { via: "canvas" };
      const asset = await s.assets.save(r.data, found.asset.mimeType, { ...(found.asset.sourceModelId ? { sourceModelId: found.asset.sourceModelId } : {}), meta: versionMeta(found.asset, "resize") });
      return { via: r.via, asset };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { parent?: string; op?: string; image?: string } }>("/api/images/version", { bodyLimit: MAX_BYTES * 2 }, async (req, reply) => {
    const b = req.body ?? {};
    // No parent: a chat file brought in as the first version.
    const parent = b.parent === undefined ? undefined : typeof b.parent === "string" && ID.test(b.parent) ? ((await s.assets.get(b.parent)) ?? null) : null;
    if (parent === null) return reply.code(404).send({ error: "Picture not found" });
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(typeof b.image === "string" ? b.image : "");
    const data = m ? Buffer.from(m[2]!, "base64") : undefined;
    if (!m || !data?.length || data.length > MAX_BYTES) return reply.code(400).send({ error: "Send the picture as a PNG, JPEG or WebP data address (up to 40 MB)." });
    const op = /^[a-z-]{1,20}$/.test(b.op ?? "") ? b.op! : "edit";
    const asset = await s.assets.save(data, m[1]!, { ...(parent?.asset.sourceModelId ? { sourceModelId: parent.asset.sourceModelId } : {}), meta: parent ? versionMeta(parent.asset, op) : { version: 1, op } });
    return { asset };
  });
}
