import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { speechRoutes } from "./speech.js";
import type { KesherServices } from "../services.js";

/** Services with only what transcription touches: the settings, and a local engine that may have a loaded model. */
function fake(o: { stt: string; loaded: boolean; clouds?: boolean }) {
  const calls: string[] = [];
  const s = {
    config: { speech: { stt: o.stt, language: "auto" }, providers: o.clouds ? [{ id: "openai", apiKey: "k" }] : [] },
    whisper: {
      status: async () => ({ engine: true, model: "base" }),
      quick: async () => (calls.push("quick"), o.loaded ? "live words" : undefined),
      transcribe: async () => (calls.push("full"), "full words"),
    },
  } as unknown as KesherServices;
  return { s, calls };
}

const wav = Buffer.alloc(4000);

test("partial transcripts use only a loaded local model; otherwise the page is told to stop asking", async () => {
  for (const [o, want] of [
    [{ stt: "local", loaded: true }, { text: "live words", partial: true }],
    [{ stt: "local", loaded: false }, { text: "", partial: false }],
    [{ stt: "cloud:openai", loaded: true, clouds: true }, { text: "", partial: false }],
  ] as const) {
    const app = Fastify();
    const { s, calls } = fake(o);
    await speechRoutes(app, s);
    const r = await app.inject({ method: "POST", url: "/api/speech/transcribe?partial=1", headers: { "content-type": "audio/wav" }, payload: wav });
    assert.deepEqual(r.json(), want, o.stt);
    assert.ok(!calls.includes("full"), "a partial never runs the slow path or the cloud");
  }
});

test("a partial bigger than a short segment is refused before the engine runs", async () => {
  const app = Fastify();
  const { s, calls } = fake({ stt: "local", loaded: true });
  await speechRoutes(app, s);
  const r = await app.inject({ method: "POST", url: "/api/speech/transcribe?partial=1", headers: { "content-type": "audio/wav" }, payload: Buffer.alloc(5 * 1024 * 1024) });
  assert.equal(r.statusCode, 413);
  assert.deepEqual(calls, []);
});
