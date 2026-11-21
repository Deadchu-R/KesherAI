import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@kesher/agent";
import { speechTools } from "./speech-tools.js";
import { timedTranscript, type WhisperEngine } from "./whisper.js";

test("timed transcripts keep short times", () => {
  const out = "[00:00:01.000 --> 00:00:04.000]   Hello there\n[00:01:05.500 --> 00:01:07.000]  [BLANK_AUDIO]\n[01:02:03.000 --> 01:02:05.000]  שלום";
  assert.equal(timedTranscript(out), "[0:01] Hello there\n[62:03] שלום");
});

test("transcribe_audio reads a recording with the local engine; speak_text saves an OpenAI voice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-speech-"));
  await writeFile(join(dir, "memo.mp3"), Buffer.alloc(2000, 1));
  await writeFile(join(dir, "notes.txt"), "x");
  const calls: string[] = [];
  const whisper = {
    status: async () => ({ engine: "/bin/whisper", model: "/m.bin" }),
    transcribe: async (_d: Buffer, lang: string, ext: string, ts: boolean) => (calls.push(`${lang}${ext}${ts}`), "the meeting starts at nine"),
  } as unknown as WhisperEngine;
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls.push(`tts:${JSON.parse(body).voice}:${req.headers.authorization}`);
      res.setHeader("content-type", "audio/mpeg");
      res.end(Buffer.from("ID3fake"));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  let providers: Array<{ id: string; type: string; apiKey?: string; baseUrl?: string }> = [];
  const tools = Object.fromEntries(speechTools({ whisper, speech: () => ({ stt: "auto", language: "he" }), providers: () => providers as never }).map((t) => [t.spec.name, t]));
  const ctx = { workspace: dir, extraRoots: [] } as unknown as ToolContext;
  try {
    const r = await tools.transcribe_audio!.run({ path: "memo.mp3", timestamps: true }, ctx);
    assert.match(r.output, /memo\.mp3 \(transcribed on this computer\):\n\nthe meeting starts at nine/);
    assert.deepEqual(calls, ["he.mp3true"]);
    await assert.rejects(tools.transcribe_audio!.run({ path: "notes.txt" }, ctx), /not an audio or video file/);

    providers = [{ id: "openai", type: "openai", apiKey: "sk-test", baseUrl: `http://127.0.0.1:${port}/v1` }];
    const s = await tools.speak_text!.run({ text: "שלום", name: "hello", voice: "alloy" }, ctx);
    assert.deepEqual(s.files, ["hello.mp3"]);
    assert.equal((await readFile(join(dir, "hello.mp3"))).toString(), "ID3fake");
    assert.equal(calls.at(-1), "tts:alloy:Bearer sk-test");
  } finally {
    srv.close();
  }
});

test("transcribeWith detects from my languages, falls back to the app's language, and can be forced", async () => {
  const { wavFrom } = await import("./whisper.js");
  const { transcribeWith } = await import("./speech-tools.js");
  const wav = wavFrom(new Float32Array(16000 * 10));
  const calls: string[] = [];
  let probs: Record<string, number> | undefined = { es: 0.5, he: 0.4 };
  const whisper = {
    status: async () => ({ engine: "/bin/whisper", model: "/m.bin" }),
    detectLanguages: async () => probs,
    transcribe: async (_d: Buffer, lang: string) => (calls.push(lang), "שלום לכולם ברוכים הבאים היום"),
  } as unknown as WhisperEngine;
  const d = { whisper, speech: () => ({ stt: "local", language: "auto" }), providers: () => [] };
  const r = await transcribeWith(d, wav, ".wav", "auto");
  assert.deepEqual([calls.at(-1), r.detected?.lang, r.detected?.outside], ["he", "he", false]);
  // No probabilities (an engine that cannot detect): the app's language.
  probs = undefined;
  const r2 = await transcribeWith(d, wav, ".wav", "auto", false, { hint: "en" });
  assert.deepEqual([calls.at(-1), r2.detected], ["en", undefined]);
  // Forced ("transcribe again as …").
  const r3 = await transcribeWith(d, wav, ".wav", "ru");
  assert.deepEqual([calls.at(-1), r3.detected?.forced], ["ru", true]);
});
