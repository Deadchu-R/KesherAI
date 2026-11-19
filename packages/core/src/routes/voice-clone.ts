import type { FastifyInstance } from "fastify";
import type { AssetStore } from "../assets.js";
import { CLONE_LANGS, type VoiceCloner } from "../voice-clone.js";

/** A voice of her own (Models → Training): set up the engine, keep a clip with consent, speak text in a voice. */
export async function voiceCloneRoutes(app: FastifyInstance, v: VoiceCloner, assets?: AssetStore): Promise<void> {
  app.get("/api/voice-clone", async () => ({ ...(await v.status()), langs: CLONE_LANGS }));
  app.post("/api/voice-clone/install", async () => {
    void v.install();
    return v.status();
  });
  app.post<{ Querystring: { name?: string; consent?: string } }>("/api/voice-clone/voices", async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "Send the clip as audio/wav." });
    return { name: await v.addVoice(String(req.query.name ?? ""), req.body, req.query.consent === "yes") };
  });
  app.delete<{ Params: { name: string } }>("/api/voice-clone/voices/:name", async (req) => {
    await v.removeVoice(req.params.name);
    return { ok: true };
  });
  // A line or a whole script in a kept voice; a script (keep: true) is also kept in the bank of everything made.
  app.post<{ Body: { voice?: string; text?: string; lang?: string; keep?: boolean } }>("/api/voice-clone/say", async (req, reply) => {
    const text = String(req.body?.text ?? "");
    const wav = await v.say(String(req.body?.voice ?? ""), text, String(req.body?.lang ?? "he"));
    if (req.body?.keep && assets) {
      const a = await assets.save(wav, "audio/wav", { meta: { prompt: text.trim().slice(0, 300), use: `voice: ${String(req.body?.voice ?? "")}` } });
      reply.header("x-asset-id", a.id);
    }
    return reply.type("audio/wav").send(wav);
  });
}
