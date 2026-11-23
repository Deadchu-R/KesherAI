import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import type { KesherServices } from "../services.js";
import { myLanguages } from "../lang-detect.js";
import { CLOUD_STT, transcribeWith } from "../speech-tools.js";
import { classifySpeechModels, HEBREW_TTS_ENGINES, type HebrewTtsEngine } from "../hebrew-tts.js";
import { scanFolder, type FoundModel } from "../model-scan.js";
import { modelsOnComputer } from "./engine.js";

/**
 * Speech models on this computer: KesherAI's own `text-to-speech` and `speech-to-text` folders under the models folder,
 * and the user's model folders (the same look as the Models page).
 *
 * @param s - Services.
 * @returns The model files found.
 */
export async function speechModelsOnComputer(s: KesherServices): Promise<FoundModel[]> {
  const own = await Promise.all(["text-to-speech", "speech-to-text"].map((f) => scanFolder({ folder: join(s.paths.models, f), source: "KesherAI" }).catch(() => [])));
  const seen = new Set<string>();
  return [...own.flat(), ...(await modelsOnComputer(s).catch(() => []))].filter((m) => !seen.has(m.path) && !!seen.add(m.path));
}

/** Why Zonos-Hebrew is found but not run (shown in Settings and "Models per job"). */
export const ZONOS_NOTE = {
  he: "Zonos דורש mamba-ssm ו-eSpeak, שלא מותקנים ב-Windows בלי צעדים ידניים; בינתיים F5-TTS מקריא עברית.",
  en: "Zonos needs mamba-ssm and eSpeak, which do not install on Windows without manual steps; F5-TTS reads Hebrew meanwhile.",
};

/**
 * Speech to text for the microphone button: status and setup of the local
 * engine (whisper.cpp), the choice of engine, and transcription.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function speechRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const clouds = () =>
    s.config.providers
      .filter((p) => CLOUD_STT[p.id] && p.apiKey)
      .map((p) => ({ id: `cloud:${p.id}`, label: CLOUD_STT[p.id]!.label }));

  /** Which engine the button uses now, what is available, and the local engine's state. */
  app.get<{ Querystring: { app?: string } }>("/api/speech/stt", async (req) => ({
    choice: s.config.speech.stt,
    language: s.config.speech.language,
    /** "My languages" as used (the default filled in), and whether the user chose them. */
    languages: myLanguages(s.config.speech.languages, req.query.app),
    languagesSet: (s.config.speech.languages?.length ?? 0) > 0,
    local: await s.whisper.status(),
    clouds: clouds(),
    ttsClouds: s.config.providers.filter((p) => p.id === "openai" && p.apiKey).map((p) => p.id),
  }));

  /** The natural voice on this computer (Kokoro): whether it is set up, and its voices. */
  app.get("/api/speech/tts/local", async () => s.kokoro.status());
  app.post("/api/speech/tts/local/setup", async (_req, reply) => {
    void s.kokoro.prepare().catch(() => undefined);
    return reply.code(202).send({ ok: true });
  });

  /**
   * The Hebrew voice (Settings › Speech): the engine chosen, F5-TTS Hebrew's state (set up, the model on the computer,
   * the download a setup needs) and Zonos when it is on the computer (found, not run; see ZONOS_NOTE).
   */
  app.get("/api/speech/tts/hebrew", async () => {
    const found = classifySpeechModels(await speechModelsOnComputer(s).catch(() => []));
    return { engine: s.config.speech.ttsHebrew, f5: await s.f5Hebrew.status(), zonos: { found: found.zonos.map((f) => f.name), supported: false, note: ZONOS_NOTE } };
  });
  /** Chooses the Hebrew voice: `{ engine: "system" | "f5" }` (Zonos is refused until it can run here). */
  app.put<{ Body: { engine?: string } }>("/api/speech/tts/hebrew", async (req, reply) => {
    const engine = req.body?.engine as HebrewTtsEngine;
    if (!HEBREW_TTS_ENGINES.includes(engine)) return reply.code(400).send({ error: "Unknown engine." });
    if (engine === "zonos") return reply.code(409).send({ error: ZONOS_NOTE.en, code: "unsupported" });
    s.config.speech.ttsHebrew = engine;
    if (engine !== "f5") s.f5Hebrew.stop();
    await s.saveConfig();
    return { ok: true };
  });
  /**
   * "Set it up" (the user's tap, from the PC or the phone): installs F5-TTS Hebrew in its own Python and makes it the
   * Hebrew voice when it is done. Already set up: only chooses it.
   */
  app.post("/api/speech/tts/hebrew/setup", async (_req, reply) => {
    const use = async () => {
      s.config.speech.ttsHebrew = "f5";
      await s.saveConfig();
    };
    if ((await s.f5Hebrew.status()).installed) {
      await use();
      return { ok: true, message: "F5-TTS Hebrew is now the Hebrew voice." };
    }
    void s.f5Hebrew.install().then(use, () => undefined);
    return reply.code(202).send({ ok: true });
  });

  /** Reads text aloud: `{ text, provider: "local", voice }` → WAV (Kokoro), or a cloud voice (OpenAI) → MP3. */
  app.post<{ Body: { text?: string; provider?: string; voice?: string; speed?: number } }>("/api/speech/tts", async (req, reply) => {
    const text = String(req.body?.text ?? "").slice(0, 4000);
    if (!text) return reply.code(400).send({ error: "No text" });
    // Hebrew with the Hebrew voice chosen in Settings: F5-TTS → WAV. A 409 with `code` tells the page to use the
    // system's voice and say why (`off`: another voice is chosen; `needs-setup`; `failed`).
    if (req.body?.provider === "hebrew") {
      if (s.config.speech.ttsHebrew !== "f5") return reply.code(409).send({ error: "No Hebrew voice on this computer is chosen.", code: "off" });
      try {
        const wav = await s.f5Hebrew.speak(text, Number(req.body.speed ?? 1) || 1);
        return reply.type("audio/wav").send(Buffer.isBuffer(wav) ? wav : Buffer.from(wav as Uint8Array));
      } catch (err) {
        const e = err as Error & { code?: string };
        return reply.code(409).send({ error: e.message, code: e.code === "needs-setup" || e.code === "busy" ? e.code : "failed" });
      }
    }
    if (req.body?.provider === "local") {
      try {
        const wav = await s.kokoro.speak(text, Number(req.body.voice ?? 3) || 3, Number(req.body.speed ?? 1) || 1);
        // Found on the PC (desktop app): the WAV reached Fastify as a plain Uint8Array ("invalid payload type
        // 'object'"); a copy into this realm's Buffer always sends.
        return reply.type("audio/wav").send(Buffer.isBuffer(wav) ? wav : Buffer.from(wav as Uint8Array));
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
    }
    const p = s.config.providers.find((x) => x.id === (req.body?.provider ?? "openai"));
    if (!p?.apiKey) return reply.code(400).send({ error: "Connect OpenAI to use its voices." });
    const res = await fetch(`${(p.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: req.body?.voice ?? "nova", input: text, format: "mp3" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return reply.code(502).send({ error: `OpenAI answered ${res.status}: ${(await res.text()).slice(0, 200)}` });
    return reply.type("audio/mpeg").send(Buffer.from(await res.arrayBuffer()));
  });

  /** Settings: `{ stt?, language? }`. */
  app.put<{ Body: { stt?: string; language?: string; languages?: unknown } }>("/api/speech/stt", async (req) => {
    if (Array.isArray(req.body?.languages)) s.config.speech.languages = myLanguages(req.body.languages, "he").slice(0, 12);
    if (typeof req.body?.stt === "string") s.config.speech.stt = req.body.stt;
    if (typeof req.body?.language === "string") s.config.speech.language = req.body.language;
    await s.saveConfig();
    return { ok: true };
  });

  /** Installs whisper.cpp and downloads its model (follow it in the downloads circle). */
  app.post<{ Body: { hebrew?: boolean } }>("/api/speech/stt/setup", async (req, reply) => {
    // { hebrew: true }: also ivrit-ai's Hebrew model (1.6 GB), used for Hebrew lectures and dictation.
    void s.whisper.prepare(!!req.body?.hebrew).catch(() => undefined);
    return reply.code(202).send({ ok: true });
  });

  /** Swaps a processor-only engine for the NVIDIA one (about 0.65 GB; follow it in the downloads circle). */
  app.post("/api/speech/stt/upgrade-gpu", async (_req, reply) => {
    void s.whisper.upgradeGpu().catch(() => undefined);
    return reply.code(202).send({ ok: true });
  });

  /** Loads the speech models ahead (the lecture recorder opens before class). */
  app.post("/api/speech/stt/warm", async () => {
    void s.whisper.warm().catch(() => undefined);
    return { ok: true };
  });

  /** The biggest live partial (`?partial=1`) accepted: 30 s of 16-bit mono at 48 kHz, with room. */
  const PARTIAL_MAX_BYTES = 4 * 1024 * 1024;
  // The recording arrives as raw WAV bytes.
  app.addContentTypeParser(["audio/wav", "audio/x-wav", "application/octet-stream"], { parseAs: "buffer", bodyLimit: 60 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  /**
   * Turns a WAV recording into text: `POST` the bytes as `audio/wav`, `?lang=he` optional. `?partial=1` (voice mode's
   * live words while the user talks): only through a loaded local model, never the cloud or the slower program;
   * `{ partial: false }` when it cannot, so the page stops asking. `?app=he|en` is the app's language (default of "my
   * languages"); the answer has `detected` (language, others heard, outside "my languages") when it was detected, and
   * `?lang=he` forces a language ("transcribe again as …").
   */
  app.post<{ Querystring: { lang?: string; partial?: string; app?: string } }>("/api/speech/transcribe", async (req, reply) => {
    const wav = req.body as Buffer;
    if (!Buffer.isBuffer(wav) || wav.length < 1000) return reply.code(400).send({ error: "Send a WAV recording as audio/wav." });
    const lang = req.query.lang ?? s.config.speech.language;
    const local = await s.whisper.status();
    const usesLocal = s.config.speech.stt === "local" || (s.config.speech.stt === "auto" && (local.engine && local.model || !clouds().length));
    if (req.query.partial === "1") {
      // A partial is the open segment only (voice-stream.ts cuts at 20 s, ~2 MB at 48 kHz): anything bigger is not
      // one, and is not worth the engine's time while the user is still talking.
      if (wav.length > PARTIAL_MAX_BYTES) return reply.code(413).send({ error: "A partial is at most a short segment." });
      const text = usesLocal && local.engine && local.model ? await s.whisper.quick(wav, lang) : undefined;
      return text === undefined ? { text: "", partial: false } : { text, partial: true };
    }
    if (usesLocal && (!local.engine || !local.model)) return reply.code(409).send({ error: "needs-setup", code: "needs-setup", ...local });
    try {
      return await transcribeWith({ whisper: s.whisper, speech: () => s.config.speech, providers: () => s.config.providers }, wav, ".wav", lang, false, { hint: req.query.app });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
