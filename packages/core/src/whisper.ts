import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    // whisper.cpp named the CUDA build "whisper-cublas-12.4.0-bin-x64.zip", now "whisper-bin-win-cuda-12.4.0-x64.zip".
    (nvidia ? (assets.find((a) => /(cublas|cuda)-12[^/]*x64\.zip$/i.test(a.name)) ?? assets.find((a) => /(cublas|cuda)[^/]*x64\.zip$/i.test(a.name))) : undefined) ??
    assets.find((a) => /^whisper-bin-x64\.zip$/i.test(a.name)) ??
    assets.find((a) => /^whisper-blas-bin-x64\.zip$/i.test(a.name)) ??
    assets.find((a) => /bin-x64\.zip$/i.test(a.name) && !/cublas|cuda/i.test(a.name))
  );
}
const MODELS = {
  // Hebrew: ivrit-ai's large-v3-turbo, trained further on Hebrew (f16, so only with a graphics card or Apple chip).
  he: { file: "ivrit-ai-large-v3-turbo.bin", sizeGb: 1.62, label: "Whisper large-v3 turbo · Hebrew (ivrit-ai)", url: "https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin" },
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
  /** The engine here runs on the processor although there is an NVIDIA card: the size (GB) of the faster download. */
  gpuUpgrade?: number;
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

  /** The speech language setting (Hebrew picks ivrit-ai's model where it runs well). */
  language: () => string = () => "auto";

  private async modelKey(): Promise<ModelKey> {
    const g = await this.gpu().catch(() => ({ nvidia: false }));
    const strong = g.nvidia || (process.platform === "darwin" && process.arch === "arm64");
    if (!strong) return "small";
    return this.language() === "he" ? "he" : "turbo";
  }

  private modelPath(key: ModelKey): string {
    return join(this.modelsDir(), "speech-to-text", "ggml-org", MODELS[key].file);
  }

  /** @returns Whether a local engine is possible on this system. */
  localPossible(): boolean {
    return process.platform === "win32" || process.platform === "darwin" || existsSync("/usr/local/bin/whisper-cli") || existsSync("/usr/bin/whisper-cli");
  }

  /** A program from the engine folder: the NVIDIA engine's when both are here (the old one is removed when it can be). */
  private async engineFile(exe: string): Promise<string | undefined> {
    const dirs = (await readdir(this.dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
    for (const d of dirs.sort((a, b) => Number(b.endsWith("-cuda")) - Number(a.endsWith("-cuda")))) {
      const f = await findFile(join(this.dir, d), exe);
      if (f) return f;
    }
    return findFile(this.dir, exe);
  }

  private async binary(): Promise<string | undefined> {
    const exe = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
    const local = await this.engineFile(exe);
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
      ...((await this.cpuOnly()) ? { gpuUpgrade: 0.65 } : {}),
    };
  }

  /** An engine is here, without its CUDA part, on a Windows computer with an NVIDIA card. */
  private async cpuOnly(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    const bin = await this.binary();
    if (!bin || existsSync(join(dirname(bin), "ggml-cuda.dll"))) return false;
    return (await this.gpu().catch(() => ({ nvidia: false }))).nvidia;
  }

  private upgrading?: Promise<void>;
  private fitTimer?: ReturnType<typeof setInterval>;

  /**
   * Keeps the engine fitting this computer's hardware without asking: on a computer with an NVIDIA card, a
   * processor-only engine is replaced by the NVIDIA one (checked 2 minutes after start, then every 6 hours, never
   * while a lecture is being transcribed). Other computers keep the processor engine, which picks the fastest code
   * for their processor (Intel or AMD) by itself.
   */
  keepFitting(): void {
    if (this.fitTimer || process.platform !== "win32") return;
    const check = () => {
      const busy = [...this.servers.values()].some((v) => Date.now() - v.used < 5 * 60_000);
      if (!busy && !this.state.busy) void this.upgradeGpu().catch(() => undefined);
    };
    setTimeout(check, 2 * 60_000).unref?.();
    this.fitTimer = setInterval(check, 6 * 3600_000);
    this.fitTimer.unref?.();
  }

  /**
   * Replaces a processor-only engine with whisper.cpp's CUDA build (the NVIDIA card makes each half minute several
   * times faster). The old engine folder is removed once the new one is in place.
   */
  upgradeGpu(): Promise<void> {
    this.upgrading ??= (async () => {
      if (!(await this.cpuOnly())) return;
      this.state = { busy: "installing" };
      const res = await fetch(RELEASES, { headers: { accept: "application/vnd.github+json", "user-agent": "KesherAI" } });
      if (!res.ok) throw new Error(`GitHub answered ${res.status} while looking for the speech engine.`);
      const releases = (await res.json()) as Array<{ tag_name: string; draft?: boolean; assets: Array<{ name: string; browser_download_url: string; size: number }> }>;
      let tag = "";
      let asset: (typeof releases)[number]["assets"][number] | undefined;
      for (const r of releases.filter((x) => !x.draft)) {
        const a = pickWhisperAsset(r.assets, true);
        if (a && /cuda|cublas/i.test(a.name)) [tag, asset] = [r.tag_name, a];
        if (asset) break;
      }
      if (!asset) throw new Error("whisper.cpp has no NVIDIA download right now. Try again later.");
      const archive = join(this.dir, asset.name);
      const into = join(this.dir, `${tag.replace(/[^\w.-]/g, "")}-cuda`);
      const job = this.downloads.enqueue({ url: asset.browser_download_url, dest: archive, size: asset.size, label: `Speech engine (NVIDIA) · ${asset.name}` });
      await waitForDownload(this.downloads, job.id);
      await rm(into, { recursive: true, force: true });
      await extractArchive(archive, into);
      await rm(archive, { force: true });
      const cli = await findFile(into, "whisper-cli.exe");
      if (!cli || !existsSync(join(dirname(cli), "ggml-cuda.dll"))) {
        await rm(into, { recursive: true, force: true });
        throw new Error("The NVIDIA speech engine download was incomplete; the current engine stays.");
      }
      // The loaded models are on the old engine: close them, then keep only the new folder.
      this.closeServers();
      await new Promise((r) => setTimeout(r, 1500));
      for (const e of await readdir(this.dir, { withFileTypes: true }))
        if (e.isDirectory() && join(this.dir, e.name) !== into) await rm(join(this.dir, e.name), { recursive: true, force: true }).catch(() => undefined);
    })()
      .catch((err: Error) => {
        this.state = { error: err.message };
        throw err;
      })
      .finally(() => {
        this.upgrading = undefined;
        if (this.state.busy === "installing") this.state = {};
      });
    return this.upgrading;
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
  prepare(hebrew = false): Promise<void> {
    this.preparing ??= (async () => {
      this.state = {};
      await this.install();
      const key: ModelKey = hebrew ? "he" : await this.modelKey();
      const dest = this.modelPath(key);
      if (!(await stat(dest).catch(() => undefined))?.size) {
        this.state = { busy: "downloading" };
        await mkdir(join(this.modelsDir(), "speech-to-text", "ggml-org"), { recursive: true });
        const m: { file: string; url?: string } = MODELS[key];
        const job = this.downloads.enqueue({ url: m.url ?? `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`, dest, size: Math.round(MODELS[key].sizeGb * 1024 ** 3), label: `Speech model · ${MODELS[key].label}` });
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
    if (!timestamps && ext.toLowerCase() === ".wav") {
      const quick = await this.fast(wav, language).catch(() => undefined);
      if (quick !== undefined) return cleanTranscript(quick);
    }
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

  /** whisper-server processes that keep a model loaded (one per model file), with when they were last used. */
  private servers = new Map<string, { port: number; proc: import("node:child_process").ChildProcess; ready: Promise<boolean>; used: number }>();
  private reaper?: ReturnType<typeof setInterval>;

  private async serverBinary(): Promise<string | undefined> {
    const exe = process.platform === "win32" ? "whisper-server.exe" : "whisper-server";
    return this.engineFile(exe);
  }

  /** A loaded model, ready for pieces (started on first use; closed after 10 idle minutes). */
  private async server(model: string): Promise<number | undefined> {
    const have = this.servers.get(model);
    if (have) {
      have.used = Date.now();
      return (await have.ready) ? have.port : undefined;
    }
    const bin = await this.serverBinary();
    if (!bin) return undefined;
    const port = 27000 + Math.floor(Math.random() * 2000);
    const proc = spawn(bin, ["-m", model, "--host", "127.0.0.1", "--port", String(port), "-t", String(Math.min(8, Math.max(2, availableParallelism() - 2)))], { windowsHide: true, stdio: "ignore" });
    const ready = (async () => {
      for (let i = 0; i < 120; i++) {
        if (proc.exitCode !== null) return false;
        if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    })();
    const entry = { port, proc, ready, used: Date.now() };
    this.servers.set(model, entry);
    proc.on("exit", () => this.servers.get(model) === entry && this.servers.delete(model));
    if (!this.reaper) process.once("exit", () => this.closeServers());
    this.reaper ??= setInterval(() => {
      for (const [k, v] of this.servers) if (Date.now() - v.used > 10 * 60_000) { v.proc.kill(); this.servers.delete(k); }
      if (!this.servers.size) { clearInterval(this.reaper); this.reaper = undefined; }
    }, 60_000);
    this.reaper.unref?.();
    if (!(await ready)) {
      proc.kill();
      this.servers.delete(model);
      return undefined;
    }
    return port;
  }

  /** Text (and the language whisper heard) from a loaded model. */
  private async viaServer(port: number, wav: Buffer, language: string): Promise<{ text: string; language?: string }> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "piece.wav");
    form.append("response_format", "verbose_json");
    form.append("language", language);
    form.append("temperature", "0");
    const r = await fetch(`http://127.0.0.1:${port}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(300_000) });
    if (!r.ok) throw new Error(`The speech engine failed (${r.status}).`);
    const j = (await r.json()) as { text?: string; language?: string; detected_language?: string };
    return { text: (j.text ?? "").trim(), ...(j.language || j.detected_language ? { language: (j.language ?? j.detected_language)!.toLowerCase() } : {}) };
  }

  /**
   * Loads the speech models ahead (the lecture recorder calls this when it opens, before class): the Hebrew model
   * when it is here, and the general one. Nothing happens without the server program (older engines).
   */
  async warm(): Promise<void> {
    const he = this.modelPath("he");
    const hasHe = !!(await stat(he).catch(() => undefined))?.size;
    const general = (await Promise.all((Object.keys(MODELS) as ModelKey[]).filter((k) => k !== "he").map(async (k) => ((await stat(this.modelPath(k)).catch(() => undefined))?.size ? this.modelPath(k) : undefined)))).find(Boolean);
    await Promise.all([hasHe ? this.server(he) : undefined, general ? this.server(general) : undefined]);
  }

  /** Closes the loaded models. */
  closeServers(): void {
    for (const v of this.servers.values()) v.proc.kill();
    this.servers.clear();
  }

  /**
   * Transcribes through loaded models when the server program is here: "auto" asks the general model (which also
   * says the language) and moves a Hebrew piece to the Hebrew model. Undefined when it cannot (then the CLI runs).
   */
  private async fast(wav: Buffer, language: string): Promise<string | undefined> {
    if (!(await this.serverBinary())) return undefined;
    const he = this.modelPath("he");
    const hasHe = !!(await stat(he).catch(() => undefined))?.size;
    const general = (await Promise.all((Object.keys(MODELS) as ModelKey[]).filter((k) => k !== "he").map(async (k) => ((await stat(this.modelPath(k)).catch(() => undefined))?.size ? this.modelPath(k) : undefined)))).find(Boolean);
    if (language === "he" && hasHe) {
      const p = await this.server(he);
      return p ? (await this.viaServer(p, wav, "he")).text : undefined;
    }
    if (!general) return undefined;
    const lang = language === "auto" && hasHe ? await this.autoLanguage(async () => "auto") : language;
    if (lang === "he" && hasHe) {
      const p = await this.server(he);
      return p ? (await this.viaServer(p, wav, "he")).text : undefined;
    }
    const gp = await this.server(general);
    if (!gp) return undefined;
    const out = await this.viaServer(gp, wav, /^[a-z]{2,3}$|^auto$/.test(lang) ? lang : "auto");
    if (language === "auto" && hasHe) {
      this.recentLangs = [...this.recentLangs.slice(0, -1), out.language ?? "auto"].slice(-3);
      if (this.recentLangs.length === 3 && this.recentLangs.every((l) => l === "he")) this.skipDetect = 4;
      if (out.language === "he") {
        const p = await this.server(he);
        if (p) return (await this.viaServer(p, wav, "he")).text;
      }
    }
    return out.text;
  }

  private recentLangs: string[] = [];
  private skipDetect = 0;

  /**
   * The language for an "auto" piece: detected each time until three pieces in a row agree, then trusted for the
   * next four (a lecture keeps its language), then checked again.
   */
  private async autoLanguage(detect: () => Promise<string>): Promise<string> {
    const last = this.recentLangs.at(-1);
    if (this.skipDetect > 0 && last && last !== "auto") {
      this.skipDetect--;
      return last;
    }
    const lang = await detect();
    this.recentLangs = [...this.recentLangs, lang].slice(-3);
    if (this.recentLangs.length === 3 && this.recentLangs.every((l) => l === lang) && lang !== "auto") this.skipDetect = 4;
    return lang;
  }

  /** Which language a recording is in (whisper's -dl: the encoder only, no text). */
  private async detect(exe: string, model: string, wav: Buffer, ext: string): Promise<string> {
    const file = join(tmpdir(), `kesher-lang-${randomUUID()}${/^\.(wav|mp3|flac|ogg)$/i.test(ext) ? ext.toLowerCase() : ".wav"}`);
    await writeFile(file, wav);
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(exe, ["-m", model, "-f", file, "-dl", "-np", "-t", String(Math.min(8, Math.max(2, availableParallelism() - 2)))], { timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(err) : resolve(`${stdout}\n${stderr}`)));
      });
      return detectedLanguage(out) ?? "auto";
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }

  private async raw(wav: Buffer, language: string, ext: string, timestamps: boolean): Promise<string> {
    const st = await this.status();
    if (!st.engine || !st.model) throw new Error("The speech engine is not ready yet.");
    const exe = (await this.binary())!;
    // Hebrew uses ivrit-ai's Hebrew model when it is here; other languages the general one.
    const heModel = this.modelPath("he");
    const hasHe = !!(await stat(heModel).catch(() => undefined))?.size;
    const general = (await Promise.all((Object.keys(MODELS) as ModelKey[]).filter((k) => k !== "he").map(async (k) => ((await stat(this.modelPath(k)).catch(() => undefined))?.size ? this.modelPath(k) : undefined)))).find(Boolean);
    // "auto" with the Hebrew model here: whisper first tells which language is spoken (one quick pass of the
    // general model), then Hebrew goes to the Hebrew model and anything else stays on the general one.
    if (language === "auto" && hasHe && general) language = await this.autoLanguage(() => this.detect(exe, general, wav, ext).catch(() => "auto"));
    const modelFile = language === "he" && hasHe ? heModel : general ?? st.model;
    const file = join(tmpdir(), `kesher-stt-${randomUUID()}${/^\.(wav|mp3|flac|ogg)$/i.test(ext) ? ext.toLowerCase() : ".wav"}`);
    await writeFile(file, wav);
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(exe, ["-m", modelFile, "-f", file, "-l", /^[a-z]{2,3}$|^auto$/.test(language) ? language : "auto", ...(timestamps ? [] : ["-nt"]), "-np", "-t", String(Math.min(8, Math.max(2, availableParallelism() - 2)))], { timeout: Math.round(Math.max(300_000, wav.length / 20)), windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
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

/**
 * The language whisper detected (`auto-detected language: he (p = 0.97)`).
 *
 * @param out - whisper-cli's output.
 * @returns The code, or undefined.
 */
export function detectedLanguage(out: string): string | undefined {
  return /auto-detected language:\s*([a-z]{2,3})\b/i.exec(out)?.[1]?.toLowerCase();
}
