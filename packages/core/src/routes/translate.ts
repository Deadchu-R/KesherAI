import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { downloadTranslationModel, findTranslationFile } from "../server/build-translator.js";
import { TRANSLATE_MAX, TRANSLATION_MODEL, autoTarget, type TranslateTarget } from "../translate.js";

/**
 * The Translate page (Hebrew ⇄ English, any text), on the computer and from the phone: KesherAI's translator
 * (translate.ts), the same one that puts image and video prompts into English.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function translateRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  /** Which model would translate now, and the small translation model's state (downloaded, downloading). */
  app.get("/api/translate", async () => {
    const which = await s.translator?.which(AbortSignal.timeout(10_000)).catch(() => undefined);
    const file = findTranslationFile(s.config, s.paths.models);
    const job = s.downloads.list().find((j) => j.label.startsWith(TRANSLATION_MODEL.name) && (j.status === "queued" || j.status === "downloading" || j.status === "verifying"));
    return {
      which: which ?? null,
      model: { name: TRANSLATION_MODEL.name, sizeGb: TRANSLATION_MODEL.sizeGb, downloaded: !!file, ...(job ? { downloading: true } : {}) },
      max: TRANSLATE_MAX,
    };
  });

  app.post<{ Body: { text?: unknown; to?: unknown } }>("/api/translate", async (req, reply) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) return reply.code(400).send({ error: "Nothing to translate." });
    if (text.length > TRANSLATE_MAX) return reply.code(400).send({ error: `The text is too long (at most ${TRANSLATE_MAX} characters).` });
    if (!s.translator) return reply.code(503).send({ error: "The translator is not available here." });
    const to: TranslateTarget = req.body?.to === "en" || req.body?.to === "he" ? req.body.to : autoTarget(text);
    // Cancelled when the page closes the request (the phone went away).
    const ctrl = new AbortController();
    req.raw.on("close", () => !reply.sent && ctrl.abort());
    try {
      const r = await s.translator.translate(text, to, { signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(300_000)]) });
      return { ...r, to };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Downloads the small translation model (TranslateGemma 4B, about 2.5 GB), asked by the user on the Translate page. */
  app.post("/api/translate/download", async (_req, reply) => {
    try {
      return await downloadTranslationModel({ downloads: s.downloads, modelsDir: s.paths.models, token: s.config.huggingFaceToken });
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
