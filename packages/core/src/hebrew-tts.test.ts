import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySpeechModels, F5Hebrew, parseWorkerLine, vocabBeside } from "./hebrew-tts.js";

test("classifySpeechModels: the Hebrew F5 checkpoint, Zonos, and speech-to-text models that are not whisper", () => {
  const m = classifySpeechModels([
    { path: "D:\\models\\text-to-speech\\Yzamari\\f5tts-hebrew-v2\\model.safetensors", name: "model.safetensors" },
    { path: "D:\\models\\text-to-speech\\notmax123\\Zonos-Hebrew\\Zonos-v0.1-hybrid.safetensors", name: "Zonos-v0.1-hybrid.safetensors" },
    { path: "D:\\models\\speech-to-text\\imvladikon\\wav2vec2-large-xlsr-53-hebrew\\pytorch_model.bin", name: "pytorch_model.bin" },
    { path: "D:\\models\\speech-to-text\\sahilmahendrakar\\Earlybird-29M\\model.safetensors", name: "model.safetensors" },
    { path: "D:\\models\\speech-to-text\\ivrit-ai\\whisper-large-v3-turbo.bin", name: "x.bin" },
    { path: "D:\\models\\text-to-speech\\SWivid\\F5-TTS\\model_1250000.safetensors", name: "model_1250000.safetensors" },
  ]);
  assert.match(m.f5!.path, /f5tts-hebrew-v2/);
  assert.equal(m.zonos.length, 1);
  assert.deepEqual(m.otherStt.map((f) => f.path.split("\\")[4]), ["wav2vec2-large-xlsr-53-hebrew", "Earlybird-29M"]);
  assert.equal(classifySpeechModels([]).f5, undefined);
});

test("vocabBeside: vocab.txt, else the checkpoint's own name, else the only .txt; never a README", async () => {
  const list = (names: string[]) => async () => names;
  assert.equal(await vocabBeside(join("m", "model.safetensors"), list(["README.txt", "vocab.txt", "x.txt"])), join("m", "vocab.txt"));
  assert.equal(await vocabBeside(join("m", "Hebrew.safetensors"), list(["Hebrew.txt", "other.txt"])), join("m", "Hebrew.txt"));
  assert.equal(await vocabBeside(join("m", "model.safetensors"), list(["chars.txt", "license.txt"])), join("m", "chars.txt"));
  assert.equal(await vocabBeside(join("m", "model.safetensors"), list(["a.txt", "b.txt"])), undefined);
});

test("parseWorkerLine: answers only from KESHER lines", () => {
  assert.deepEqual(parseWorkerLine('KESHER {"id":"1","ok":true}'), { id: "1", ok: true });
  assert.equal(parseWorkerLine('KESHER {"id":"2","ok":false,"error":"x"}')?.ok, false);
  assert.equal(parseWorkerLine("Loading model…"), undefined);
  assert.equal(parseWorkerLine("KESHER {broken"), undefined);
});

/** A stand-in for the Python worker: writes a tiny WAV for each request; "fail" answers with an error. */
const FAKE = `const rl = require("node:readline").createInterface({ input: process.stdin });
console.log("LOADED cuda");
rl.on("line", (l) => {
  const r = JSON.parse(l);
  if (r.text === "fail") return console.log("KESHER " + JSON.stringify({ id: r.id, ok: false, error: "out of memory" }));
  require("node:fs").writeFileSync(r.out, "RIFF" + r.text);
  console.log("KESHER " + JSON.stringify({ id: r.id, ok: true }));
});`;

/** An engine folder that looks set up (the venv's Python and the "installed" mark). */
async function setUpEngine(): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "kesher-f5-"));
  const py = join(dir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  await mkdir(join(py, ".."), { recursive: true });
  await writeFile(py, "");
  await writeFile(join(dir, "installed-ok"), "");
  return { dir };
}

test("F5Hebrew: needs setup first; then one worker reads sentence after sentence and reports its errors", async () => {
  const bare = new F5Hebrew(await mkdtemp(join(tmpdir(), "kesher-f5-")), { uv: async () => "uv", nvidia: async () => true, checkpoint: async () => ({}) });
  await assert.rejects(bare.speak("שלום"), (e: Error & { code?: string }) => e.code === "needs-setup");
  const st = await bare.status();
  assert.equal(st.installed, false);
  assert.equal(st.sizeGb, 4.9, "the engine and the fine-tune, when it is not on the computer");

  const { dir } = await setUpEngine();
  let starts = 0;
  const f5 = new F5Hebrew(dir, {
    uv: async () => "uv",
    nvidia: async () => true,
    checkpoint: async () => ({ model: join(dir, "model.safetensors"), vocab: join(dir, "vocab.txt") }),
    spawnWorker: (_py, _args, env) => (starts++, spawn(process.execPath, ["-e", FAKE], { env })),
  });
  assert.equal((await f5.status()).sizeGb, 0);
  assert.equal((await f5.speak("שלום")).toString(), "RIFFשלום");
  assert.equal((await f5.speak("מה נשמע")).toString(), "RIFFמה נשמע");
  assert.equal(starts, 1, "the model stays loaded between sentences");
  assert.equal((await f5.status()).loaded, true);
  await assert.rejects(f5.speak("fail"), /out of memory/);
  assert.equal((await f5.status()).phase, "error");
  f5.stop();
  assert.equal((await f5.status()).loaded, false);
});
