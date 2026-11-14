import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { CLOUD_STT, transcribeWith } from "../speech-tools.js";

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
  app.get("/api/speech/stt", async () => ({
    choice: s.config.speech.stt,
    language: s.config.speech.language,
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

  /** Reads text aloud: `{ text, provider: "local", voice }` → WAV (Kokoro), or a cloud voice (OpenAI) → MP3. */
  app.post<{ Body: { text?: string; provider?: string; voice?: string; speed?: number } }>("/api/speech/tts", async (req, reply) => {
    const text = String(req.body?.text ?? "").slice(0, 4000);
    if (!text) return reply.code(400).send({ error: "No text" });
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
  app.put<{ Body: { stt?: string; language?: string } }>("/api/speech/stt", async (req) => {
    if (typeof req.body?.stt === "string") s.config.speech.stt = req.body.stt;
    if (typeof req.body?.language === "string") s.config.speech.language = req.body.language;
    await s.saveConfig();
    return { ok: true };
  });

  /** Installs whisper.cpp and downloads its model (follow it in the downloads circle). */
  app.post("/api/speech/stt/setup", async (_req, reply) => {
    void s.whisper.prepare().catch(() => undefined);
    return reply.code(202).send({ ok: true });
  });

  // The recording arrives as raw WAV bytes.
  app.addContentTypeParser(["audio/wav", "audio/x-wav", "application/octet-stream"], { parseAs: "buffer", bodyLimit: 60 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  /** Turns a WAV recording into text: `POST` the bytes as `audio/wav`, `?lang=he` optional. */
  app.post<{ Querystring: { lang?: string } }>("/api/speech/transcribe", async (req, reply) => {
    const wav = req.body as Buffer;
    if (!Buffer.isBuffer(wav) || wav.length < 1000) return reply.code(400).send({ error: "Send a WAV recording as audio/wav." });
    const lang = req.query.lang ?? s.config.speech.language;
    const local = await s.whisper.status();
    const usesLocal = s.config.speech.stt === "local" || (s.config.speech.stt === "auto" && (local.engine && local.model || !clouds().length));
    if (usesLocal && (!local.engine || !local.model)) return reply.code(409).send({ error: "needs-setup", code: "needs-setup", ...local });
    try {
      return await transcribeWith({ whisper: s.whisper, speech: () => s.config.speech, providers: () => s.config.providers }, wav, ".wav", lang);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
