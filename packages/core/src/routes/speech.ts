import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { cloudTranscribe } from "../whisper.js";

/** Cloud services that transcribe through an OpenAI-compatible endpoint, with their model. */
const CLOUD_STT: Record<string, { model: string; label: string }> = {
  groq: { model: "whisper-large-v3-turbo", label: "Groq (Whisper large-v3 turbo)" },
  openai: { model: "gpt-4o-mini-transcribe", label: "OpenAI" },
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
  app.get("/api/speech/stt", async () => ({
    choice: s.config.speech.stt,
    language: s.config.speech.language,
    local: await s.whisper.status(),
    clouds: clouds(),
    ttsClouds: s.config.providers.filter((p) => p.id === "openai" && p.apiKey).map((p) => p.id),
  }));

  /** Reads text aloud with a cloud voice (OpenAI): `{ text, voice }` → MP3. */
  app.post<{ Body: { text?: string; provider?: string; voice?: string } }>("/api/speech/tts", async (req, reply) => {
    const text = String(req.body?.text ?? "").slice(0, 4000);
    if (!text) return reply.code(400).send({ error: "No text" });
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
    const choice = s.config.speech.stt;
    const local = await s.whisper.status();
    const cloud = choice.startsWith("cloud:") ? choice.slice(6) : choice === "auto" && !(local.engine && local.model) ? clouds()[0]?.id.slice(6) : undefined;
    try {
      if (cloud) {
        const p = s.config.providers.find((x) => x.id === cloud);
        if (!p?.apiKey) return reply.code(400).send({ error: `The ${cloud} connection has no API key.` });
        const base = p.baseUrl ?? (cloud === "openai" ? "https://api.openai.com/v1" : "https://api.groq.com/openai/v1");
        return { text: await cloudTranscribe(base, p.apiKey, CLOUD_STT[cloud]?.model ?? "whisper-1", wav, lang), engine: cloud };
      }
      if (!local.engine || !local.model) return reply.code(409).send({ error: "needs-setup", code: "needs-setup", ...local });
      return { text: await s.whisper.transcribe(wav, lang), engine: "local" };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
