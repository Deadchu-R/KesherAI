import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { DownloadManager } from "@kesher/downloads";
import { extractArchive, waitForDownload } from "./llamacpp.js";
import type { Speakers } from "./speakers.js";
import { wavFrom } from "./whisper.js";

/** Kokoro 82M (Apache-2.0), 8-bit, as sherpa-onnx publishes it (English voices; about 130 MB). */
const MODEL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2";

/** Voices to choose from (speaker ids in Kokoro v1.0). */
export const KOKORO_VOICES: Array<{ id: number; name: string }> = [
  { id: 3, name: "Heart (US, woman)" },
  { id: 2, name: "Bella (US, woman)" },
  { id: 9, name: "Sarah (US, woman)" },
  { id: 11, name: "Adam (US, man)" },
  { id: 16, name: "Michael (US, man)" },
  { id: 21, name: "Emma (UK, woman)" },
  { id: 26, name: "George (UK, man)" },
];

/**
 * A natural voice on this computer: Kokoro through the sherpa-onnx addon
 * (the same one speaker separation uses), in a worker thread. English
 * only; Hebrew stays with the system's voices.
 */
export class Kokoro {
  private preparing: Promise<void> | undefined;
  private worker: Worker | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * @param dir - Where the model goes.
   * @param speakers - Owns the sherpa-onnx addon.
   * @param downloads - Downloads (shown in the downloads circle).
   */
  constructor(private readonly dir: string, private readonly speakers: Speakers, private readonly downloads: DownloadManager) {}

  private get model() {
    return join(this.dir, "kokoro");
  }

  /** @returns Whether it can speak now, and the voices. */
  status(): { ready: boolean; busy: boolean; sizeMb: number; voices: typeof KOKORO_VOICES } {
    const ready = this.speakers.addonReady && existsSync(join(this.model, "model.int8.onnx"));
    return { ready, busy: !!this.preparing, sizeMb: ready ? 0 : this.speakers.addonReady ? 130 : 160, voices: KOKORO_VOICES };
  }

  /** Downloads the voice (and the addon) the first time. */
  prepare(): Promise<void> {
    this.preparing ??= (async () => {
      await this.speakers.installAddon("Voice");
      if (existsSync(join(this.model, "model.int8.onnx"))) return;
      const archive = join(this.dir, "downloads", "kokoro.tar.bz2");
      if (!existsSync(archive)) await waitForDownload(this.downloads, this.downloads.enqueue({ url: MODEL, dest: archive, label: "Voice · Kokoro" }).id);
      const tmp = join(this.dir, `tmp-${randomUUID()}`);
      await extractArchive(archive, tmp);
      const folder = (await readdir(tmp))[0] ?? "";
      await mkdir(this.dir, { recursive: true });
      await rm(this.model, { recursive: true, force: true });
      await rename(join(tmp, folder), this.model);
      await rm(tmp, { recursive: true, force: true });
      await rm(join(this.dir, "downloads"), { recursive: true, force: true });
    })().finally(() => {
      this.preparing = undefined;
    });
    return this.preparing;
  }

  /**
   * Says text with a Kokoro voice.
   *
   * @param text - English text.
   * @param voice - A speaker id from {@link KOKORO_VOICES}.
   * @param speed - 1 is normal.
   * @returns A WAV file.
   */
  async speak(text: string, voice = 3, speed = 1): Promise<Buffer> {
    if (!this.status().ready) throw new Error("The local voice is not set up yet.");
    const run = this.queue.then(() => this.synth(text, voice, speed));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private synth(text: string, voice: number, speed: number): Promise<Buffer> {
    const d = this.model;
    // One worker stays loaded (the model takes a few seconds to load).
    this.worker ??= new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       const sherpa = require(workerData.addon);
       const d = workerData.dir;
       const tts = new sherpa.OfflineTts({
         model: { kokoro: { model: d + "/model.int8.onnx", voices: d + "/voices.bin", tokens: d + "/tokens.txt", lexicon: d + "/lexicon-us-en.txt", dictDir: d + "/dict" }, numThreads: workerData.threads },
       });
       parentPort.on("message", ({ id, text, sid, speed }) => {
         try {
           // Electron forbids external buffers ("External buffers are not allowed"): the samples are copied.
           const a = tts.generate({ text, sid, speed, enableExternalBuffer: false });
           parentPort.postMessage({ id, samples: a.samples, rate: a.sampleRate });
         } catch (e) {
           parentPort.postMessage({ id, error: String(e && e.message || e) });
         }
       });`,
      { eval: true, workerData: { addon: this.speakers.addonPath, dir: d, threads: Math.min(4, Math.max(1, availableParallelism() - 2)) } },
    );
    const worker = this.worker;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const onMsg = (m: { id: string; samples?: Float32Array; rate?: number; error?: string }) => {
        if (m.id !== id) return;
        worker.off("message", onMsg);
        worker.off("error", onErr);
        if (m.error || !m.samples) reject(new Error(m.error ?? "No audio"));
        else resolve(wavFrom(m.samples, m.rate ?? 24000));
      };
      const onErr = (e: Error) => {
        worker.off("message", onMsg);
        this.worker = undefined;
        reject(e);
      };
      worker.on("message", onMsg);
      worker.once("error", onErr);
      worker.postMessage({ id, text: text.slice(0, 4000), sid: voice, speed });
    });
  }
}
