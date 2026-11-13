import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DownloadManager } from "@kesher/downloads";
import { extractArchive, waitForDownload } from "./llamacpp.js";
import { findFile } from "./sdcpp.js";

/**
 * Speech to text on this computer with whisper.cpp: the microphone button
 * records, and whisper turns it into text (Hebrew and ~100 other languages).
 *
 * The engine comes from whisper.cpp's GitHub releases on Windows (the CUDA
 * build when there is an NVIDIA card), and from Homebrew on a Mac. The model
 * is large-v3-turbo (good Hebrew) on a computer with a graphics card, and
 * small otherwise. Cloud transcription (Groq, OpenAI) is used instead when
 * the user picks it, or when the local engine cannot run here.
 */

const RELEASES = "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=8";

/**
 * Picks the Windows download of a whisper.cpp release: the CUDA build when
 * there is an NVIDIA card, else the plain (or BLAS) 64-bit build.
 *
 * @param assets - The release's files.
 * @param nvidia - Whether there is an NVIDIA card.
 * @returns The file, if the release has one for this computer.
 */
export function pickWhisperAsset<T extends { name: string }>(assets: T[], nvidia: boolean): T | undefined {
  return (
    (nvidia ? (assets.find((a) => /whisper-cublas-12.*bin-x64\.zip$/i.test(a.name)) ?? assets.find((a) => /cublas.*bin-x64\.zip$/i.test(a.name))) : undefined) ??
    assets.find((a) => /^whisper-bin-x64\.zip$/i.test(a.name)) ??
    assets.find((a) => /^whisper-blas-bin-x64\.zip$/i.test(a.name)) ??
    assets.find((a) => /bin-x64\.zip$/i.test(a.name) && !/cublas|cuda/i.test(a.name))
  );
}
const MODELS = {
  turbo: { file: "ggml-large-v3-turbo-q5_0.bin", sizeGb: 0.55, label: "Whisper large-v3 turbo" },
  small: { file: "ggml-small-q5_1.bin", sizeGb: 0.19, label: "Whisper small" },
} as const;
type ModelKey = keyof typeof MODELS;

/** What the speech engine is doing. */
export interface SttStatus {
  /** Whether the engine program is here. */
  engine: boolean;
  /** The model file, once downloaded. */
  model?: string;
  /** Which model this computer should use, and its download size. */
  recommended: { label: string; sizeGb: number };
  /** `installing`, `downloading`, or an error to show. */
  busy?: string;
  error?: string;
  /** Whether a local engine exists for this system at all (else only cloud). */
  localPossible: boolean;
}

/**
 * Builds a 16-bit PCM mono WAV file header + data.
 *
 * @param samples - Float samples in [-1, 1].
 * @param rate - Sample rate.
 * @returns The WAV file.
 */
export function wavFrom(samples: Float32Array, rate = 16000): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((samples[i] ?? 0) * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/**
 * Cleans whisper's text output: drops timestamps and bracketed noise tags.
 *
 * @param out - What whisper-cli printed.
 * @returns The spoken text.
 */
export function cleanTranscript(out: string): string {
  return out
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[\d:.]+ --> [\d:.]+\]\s*/, "").trim())
    .filter((l) => l && !/^\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]$|^\((music|silence)\)$/i.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keeps whisper's times as short `[m:ss]` marks, one line per segment.
 *
 * @param out - What whisper-cli printed with timestamps.
 * @returns Lines like `[1:05] and then we…`.
 */
export function timedTranscript(out: string): string {
  return out
    .split(/\r?\n/)
    .flatMap((l) => {
      const m = /^\[(\d+):(\d+):(\d+)[.,]\d+ --> [\d:.,]+\]\s*(.*)$/.exec(l.trim());
      if (!m || !m[4] || /^\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]$/i.test(m[4])) return [];
      const h = Number(m[1]);
      const mm = Number(m[2]) + h * 60;
      return [`[${mm}:${m[3]}] ${m[4].trim()}`];
    })
    .join("\n");
}

/** A piece of speech with its times, in seconds. */
export interface SpeechPart {
  start: number;
  end: number;
  text: string;
}

/**
 * Reads whisper's timed output into pieces.
 *
 * @param out - What whisper-cli printed with timestamps.
 * @returns The pieces, without noise tags.
 */
export function speechParts(out: string): SpeechPart[] {
  const sec = (h: string, m: string, s: string) => Number(h) * 3600 + Number(m) * 60 + Number(s.replace(",", "."));
  return out.split(/\r?\n/).flatMap((l) => {
    const m = /^\[(\d+):(\d+):([\d.,]+) --> (\d+):(\d+):([\d.,]+)\]\s*(.*)$/.exec(l.trim());
    const text = m?.[7]?.trim();
    if (!m || !text || /^\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]$|^\((music|silence)\)$/i.test(text)) return [];
    return [{ start: sec(m[1]!, m[2]!, m[3]!), end: sec(m[4]!, m[5]!, m[6]!), text }];
  });
}

/** Runs whisper.cpp and owns its files. */
export class WhisperEngine {
  private installing?: Promise<string>;
  private preparing?: Promise<void>;
  private state: { busy?: string; error?: string } = {};

  /**
   * @param dir - Engine folder.
   * @param modelsDir - Where models go.
   * @param downloads - The download queue.
   * @param gpu - Whether there is an NVIDIA card (picks the CUDA build and the bigger model).
   */
  constructor(
    private readonly dir: string,
    private readonly modelsDir: () => string,
    private readonly downloads: DownloadManager,
    private readonly gpu: () => Promise<{ nvidia: boolean; vramGb?: number }>,
  ) {}

  private async modelKey(): Promise<ModelKey> {
    const g = await this.gpu().catch(() => ({ nvidia: false }));
    return g.nvidia || (process.platform === "darwin" && process.arch === "arm64") ? "turbo" : "small";
  }

  private modelPath(key: ModelKey): string {
    return join(this.modelsDir(), "speech-to-text", "ggml-org", MODELS[key].file);
  }

  /** @returns Whether a local engine is possible on this system. */
  localPossible(): boolean {
    return process.platform === "win32" || process.platform === "darwin" || existsSync("/usr/local/bin/whisper-cli") || existsSync("/usr/bin/whisper-cli");
  }

  private async binary(): Promise<string | undefined> {
    const exe = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
    const local = await findFile(this.dir, exe);
    if (local) return local;
    for (const p of ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli", "/usr/bin/whisper-cli"]) if (existsSync(p)) return p;
    return undefined;
  }

  /** @returns The engine's state. */
  async status(): Promise<SttStatus> {
    const key = await this.modelKey();
    const model = (await Promise.all((Object.keys(MODELS) as ModelKey[]).map(async (k) => ((await stat(this.modelPath(k)).catch(() => undefined))?.size ? this.modelPath(k) : undefined)))).find(Boolean);
    return {
      engine: !!(await this.binary()),
      ...(model ? { model } : {}),
      recommended: { label: MODELS[key].label, sizeGb: MODELS[key].sizeGb + (process.platform === "win32" && !(await this.binary()) ? 0.4 : 0) },
      ...this.state,
      localPossible: this.localPossible(),
    };
  }

  private install(): Promise<string> {
    this.installing ??= (async () => {
      const found = await this.binary();
      if (found) return found;
      if (process.platform === "darwin") {
        this.state = { busy: "installing" };
        // Homebrew is how whisper.cpp ships for Macs.
        await new Promise<void>((ok, fail) => {
          const p = spawn("/bin/sh", ["-lc", "brew install whisper-cpp"], { stdio: "ignore" });
          p.on("error", () => fail(new Error("Homebrew is not installed; use a cloud speech service, or install Homebrew from brew.sh.")));
          p.on("close", (code) => (code === 0 ? ok() : fail(new Error("brew install whisper-cpp failed."))));
        });
        const b = await this.binary();
        if (!b) throw new Error("whisper-cli was not found after installing.");
        return b;
      }
      if (process.platform !== "win32") throw new Error("There is no ready-made whisper.cpp for Linux. Use a cloud speech service (Groq or OpenAI) under Settings → Speech.");
      this.state = { busy: "installing" };
      // The newest release can be published before its files are uploaded: look through the last few.
      const res = await fetch(RELEASES, { headers: { accept: "application/vnd.github+json", "user-agent": "KesherAI" } });
      if (!res.ok) throw new Error(`GitHub answered ${res.status} while looking for the speech engine.`);
      const releases = (await res.json()) as Array<{ tag_name: string; draft?: boolean; assets: Array<{ name: string; browser_download_url: string; size: number }> }>;
      const { nvidia } = await this.gpu().catch(() => ({ nvidia: false }));
      let release: (typeof releases)[number] | undefined;
      let asset: (typeof releases)[number]["assets"][number] | undefined;
      for (const r of releases.filter((x) => !x.draft)) {
        asset = pickWhisperAsset(r.assets, nvidia);
        if (asset) {
          release = r;
          break;
        }
      }
      if (!asset || !release) throw new Error("whisper.cpp has no download for this computer right now. Try again later, or use a cloud speech service under Settings → Speech.");
      await mkdir(this.dir, { recursive: true });
      const archive = join(this.dir, asset.name);
      const job = this.downloads.enqueue({ url: asset.browser_download_url, dest: archive, size: asset.size, label: `Speech engine · ${asset.name}` });
      await waitForDownload(this.downloads, job.id);
      await extractArchive(archive, join(this.dir, release.tag_name));
      await rm(archive, { force: true });
      const b = (await this.binary()) ?? (await findFile(this.dir, "main.exe"));
      if (!b) throw new Error("The speech engine download did not contain whisper-cli.exe.");
      return b;
    })()
      .catch((err: Error) => {
        this.installing = undefined;
        this.state = { error: err.message };
        throw err;
      })
      .finally(() => {
        if (this.state.busy === "installing") this.state = {};
      });
    return this.installing;
  }

  /** Installs the engine and downloads the model (both shown in the downloads circle). Resolves when ready. */
  prepare(): Promise<void> {
    this.preparing ??= (async () => {
      this.state = {};
      await this.install();
      const key = await this.modelKey();
      const dest = this.modelPath(key);
      if (!(await stat(dest).catch(() => undefined))?.size) {
        this.state = { busy: "downloading" };
        await mkdir(join(this.modelsDir(), "speech-to-text", "ggml-org"), { recursive: true });
        const job = this.downloads.enqueue({ url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODELS[key].file}`, dest, size: Math.round(MODELS[key].sizeGb * 1024 ** 3), label: `Speech model · ${MODELS[key].label}` });
        await waitForDownload(this.downloads, job.id);
      }
      this.state = {};
    })()
      .catch((err: Error) => {
        this.state = { error: err.message };
        throw err;
      })
      .finally(() => {
        this.preparing = undefined;
      });
    return this.preparing;
  }

  /**
   * Turns speech into text.
   *
   * @param wav - A WAV file (16 kHz mono is best; the app records that).
   * @param language - `auto`, or a code like `he` or `en`.
   * @param ext - The file type: .wav, .mp3, .flac or .ogg.
   * @param timestamps - Keep whisper's [00:00:01.000 --> …] times.
   * @returns The text.
   */
  async transcribe(wav: Buffer, language = "auto", ext = ".wav", timestamps = false): Promise<string> {
    const out = await this.raw(wav, language, ext, timestamps);
    return timestamps ? timedTranscript(out) : cleanTranscript(out);
  }

  /**
   * Turns speech into text pieces with their times (seconds from the start).
   *
   * @param wav - A WAV file.
   * @param language - `auto`, or a code like `he`.
   * @returns The pieces.
   */
  async transcribeParts(wav: Buffer, language = "auto"): Promise<SpeechPart[]> {
    return speechParts(await this.raw(wav, language, ".wav", true));
  }

  private async raw(wav: Buffer, language: string, ext: string, timestamps: boolean): Promise<string> {
    const st = await this.status();
    if (!st.engine || !st.model) throw new Error("The speech engine is not ready yet.");
    const exe = (await this.binary())!;
    const file = join(tmpdir(), `kesher-stt-${randomUUID()}${/^\.(wav|mp3|flac|ogg)$/i.test(ext) ? ext.toLowerCase() : ".wav"}`);
    await writeFile(file, wav);
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(exe, ["-m", st.model!, "-f", file, "-l", /^[a-z]{2,3}$|^auto$/.test(language) ? language : "auto", ...(timestamps ? [] : ["-nt"]), "-np", "-t", String(Math.min(8, Math.max(2, availableParallelism() - 2)))], { timeout: Math.round(Math.max(300_000, wav.length / 20)), windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) reject(new Error(`The speech engine failed: ${(stderr || err.message).toString().trim().split("\n").slice(-3).join(" ")}`));
          else resolve(stdout.toString());
        });
      });
      return out;
    } finally {
      await rm(file, { force: true });
    }
  }
}

/**
 * Cloud speech to text through an OpenAI-compatible `/audio/transcriptions`
 * endpoint (Groq is fast and has a free tier; OpenAI works too).
 *
 * @param baseUrl - The API's base URL (e.g. https://api.groq.com/openai/v1).
 * @param apiKey - The key.
 * @param model - e.g. `whisper-large-v3-turbo` (Groq) or `whisper-1` (OpenAI).
 * @param wav - The recording.
 * @param language - Optional language code.
 * @returns The text.
 */
export async function cloudTranscribe(baseUrl: string, apiKey: string, model: string, wav: Buffer, language?: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
  form.append("model", model);
  if (language && language !== "auto") form.append("language", language);
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`The speech service answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return String(((await res.json()) as { text?: string }).text ?? "").trim();
}
