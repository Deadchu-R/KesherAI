import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { arch, availableParallelism, platform } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { DownloadManager } from "@kesher/downloads";
import { extractArchive, waitForDownload } from "./llamacpp.js";

/** sherpa-onnx (Apache-2.0) as a Node addon, from npm. */
const SHERPA_VERSION = "2.0.1";
const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
/** pyannote segmentation 3.0 (MIT) and 3D-Speaker ERes2Net (Apache-2.0), as sherpa-onnx publishes them. */
const SEGMENTATION = `${RELEASES}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`;
const EMBEDDING = `${RELEASES}/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`;

/** Who spoke when, in seconds; speakers are numbered from 0. */
export interface SpeakerTurn {
  start: number;
  end: number;
  speaker: number;
}

/** The addon's package for this computer, e.g. `sherpa-onnx-win-x64`. */
function platformPackage(): string {
  return `sherpa-onnx-${platform() === "win32" ? "win" : platform()}-${arch()}`;
}

/**
 * Tells speakers apart in a recording (speaker diarization), on this
 * computer: sherpa-onnx with a small segmentation model and a voice
 * fingerprint model, about 75 MB in all, downloaded the first time.
 */
export class Speakers {
  private preparing: Promise<void> | undefined;

  /**
   * @param dir - Where the engine and its models go.
   * @param downloads - Downloads (shown in the downloads circle).
   */
  constructor(private readonly dir: string, private readonly downloads: DownloadManager) {}

  private get files() {
    return {
      addon: join(this.dir, "node_modules", "sherpa-onnx-node", "sherpa-onnx.js"),
      native: join(this.dir, "node_modules", platformPackage(), "sherpa-onnx.node"),
      segmentation: join(this.dir, "models", "segmentation.onnx"),
      embedding: join(this.dir, "models", "embedding.onnx"),
    };
  }

  /** @returns Whether it can run, and what is still to download. */
  status(): { ready: boolean; busy: boolean; sizeMb: number } {
    const f = this.files;
    const ready = existsSync(f.addon) && existsSync(f.native) && existsSync(f.segmentation) && existsSync(f.embedding);
    return { ready, busy: !!this.preparing, sizeMb: ready ? 0 : 75 };
  }

  /** Downloads what is missing (follow it in the downloads circle). */
  prepare(): Promise<void> {
    this.preparing ??= this.download().finally(() => {
      this.preparing = undefined;
    });
    return this.preparing;
  }

  /** The sherpa-onnx addon's script, for other engines that use it (text to speech). */
  get addonPath(): string {
    return this.files.addon;
  }

  /** Whether the sherpa-onnx addon is installed. */
  get addonReady(): boolean {
    return existsSync(this.files.addon) && existsSync(this.files.native);
  }

  /**
   * Installs the sherpa-onnx addon (from npm) when it is missing.
   *
   * @param label - What the downloads circle shows it as.
   */
  async installAddon(label = "Speaker separation"): Promise<void> {
    const f = this.files;
    const npm = async (pkg: string, target: string) => {
      if (existsSync(target)) return;
      const tgz = await this.get(`https://registry.npmjs.org/${pkg}/-/${pkg}-${SHERPA_VERSION}.tgz`, `${pkg}.tgz`, `${label} · ${pkg}`);
      const tmp = join(this.dir, `tmp-${randomUUID()}`);
      await extractArchive(tgz, tmp);
      await mkdir(join(this.dir, "node_modules"), { recursive: true });
      await rm(join(this.dir, "node_modules", pkg), { recursive: true, force: true });
      await rename(join(tmp, "package"), join(this.dir, "node_modules", pkg));
      await rm(tmp, { recursive: true, force: true });
      await rm(tgz, { force: true });
    };
    await npm("sherpa-onnx-node", join(this.dir, "node_modules", "sherpa-onnx-node", "package.json"));
    await npm(platformPackage(), f.native);
  }

  private async get(url: string, name: string, label: string): Promise<string> {
    const dest = join(this.dir, "downloads", name);
    if (!existsSync(dest)) await waitForDownload(this.downloads, this.downloads.enqueue({ url, dest, label }).id);
    return dest;
  }

  private async download(): Promise<void> {
    const f = this.files;
    const get = (url: string, name: string, label: string) => this.get(url, name, label);
    await this.installAddon();
    await mkdir(join(this.dir, "models"), { recursive: true });
    if (!existsSync(f.segmentation)) {
      const archive = await get(SEGMENTATION, "segmentation.tar.bz2", "Speaker separation · pyannote segmentation");
      const tmp = join(this.dir, `tmp-${randomUUID()}`);
      await extractArchive(archive, tmp);
      const folder = (await readdir(tmp))[0] ?? "";
      await rename(join(tmp, folder, "model.int8.onnx"), f.segmentation);
      await rm(tmp, { recursive: true, force: true });
    }
    if (!existsSync(f.embedding)) await rename(await get(EMBEDDING, "embedding.onnx", "Speaker separation · voice fingerprints"), f.embedding);
    await rm(join(this.dir, "downloads"), { recursive: true, force: true });
  }

  /**
   * Finds who spoke when, in a worker thread (it takes a while on long recordings).
   *
   * @param samples - 16 kHz mono audio.
   * @param signal - Abort to stop.
   * @returns The turns, in order.
   */
  async diarize(samples: Float32Array, signal?: AbortSignal): Promise<SpeakerTurn[]> {
    if (!this.status().ready) throw new Error("Speaker separation is not set up yet.");
    const f = this.files;
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       const sherpa = require(workerData.addon);
       const sd = new sherpa.OfflineSpeakerDiarization({
         segmentation: { pyannote: { model: workerData.segmentation }, numThreads: workerData.threads },
         embedding: { model: workerData.embedding, numThreads: workerData.threads },
         clustering: { numClusters: -1, threshold: 0.9 },
         minDurationOn: 0.3,
         minDurationOff: 0.5,
       });
       parentPort.postMessage(sd.process(workerData.samples));`,
      { eval: true, workerData: { ...f, samples, threads: Math.min(8, Math.max(2, availableParallelism() - 2)) } },
    );
    return new Promise((resolve, reject) => {
      const stop = () => void worker.terminate().then(() => reject(new Error("Stopped.")));
      signal?.addEventListener("abort", stop, { once: true });
      worker.once("message", (turns: SpeakerTurn[]) => {
        signal?.removeEventListener("abort", stop);
        void worker.terminate();
        resolve(turns);
      });
      worker.once("error", (e) => {
        signal?.removeEventListener("abort", stop);
        reject(e);
      });
    });
  }
}

/** Where a meeting's call audio waits until the write-up (deleted after). */
export function meetingAudioDir(journalDir: string, id: string): string {
  return join(journalDir, "meeting-audio", id.replace(/[^\w-]/g, ""));
}

