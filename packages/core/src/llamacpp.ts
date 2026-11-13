import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFit, type FitPlan } from "./fit-preview.js";
import { mtpLayers } from "./gguf.js";
import type { DownloadJob, DownloadManager } from "@kesher/downloads";
import { userChoseGpus, type GpuPlan } from "./gpus.js";

/** Platform facts that decide which llama.cpp build to download. */
export interface PlatformInfo {
  platform: NodeJS.Platform;
  arch: string;
  /** Whether an NVIDIA GPU was found (then the CUDA build is used). */
  nvidia: boolean;
  /**
   * Whether an AMD or Intel card (or an NVIDIA card with no CUDA build here) can run on Vulkan. On Linux this
   * also needs Vulkan's loader (libvulkan.so.1); without it the processor build is used and the label says
   * what to install.
   */
  vulkan?: boolean;
  /** A graphics card is there but Linux has no Vulkan loader: what to tell the user. */
  vulkanMissing?: boolean;
  /** The processor's name (a Snapdragon gets the Windows arm64 build, also when the app runs as x64). */
  cpu?: string;
}

/** Common places of Vulkan's loader on Linux (distributions differ). */
const VULKAN_LOADERS = ["/usr/lib/x86_64-linux-gnu/libvulkan.so.1", "/usr/lib/aarch64-linux-gnu/libvulkan.so.1", "/usr/lib64/libvulkan.so.1", "/usr/lib/libvulkan.so.1", "/lib/x86_64-linux-gnu/libvulkan.so.1", "/usr/local/lib/libvulkan.so.1"];

/**
 * The facts that decide which llama.cpp build this computer gets.
 *
 * @param hw - Its hardware.
 * @param hasFile - For tests.
 * @returns Platform facts.
 */
export function enginePlatform(hw: { gpus: Array<{ vendor?: string; name: string; vramTotal: number }>; cpu: string }, hasFile: (p: string) => boolean = existsSync): PlatformInfo {
  const nvidia = hw.gpus.some((g) => g.vendor === "nvidia" || /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(g.name));
  // A card with memory of its own, or Intel Arc (its memory is not always reported). Built-in graphics alone are
  // not faster than the processor for this.
  const other = hw.gpus.some((g) => (g.vendor === "amd" || g.vendor === "intel") && (g.vramTotal >= 2 * 1024 ** 3 || /arc|radeon rx|radeon pro|instinct/i.test(g.name)));
  const loader = process.platform !== "linux" || VULKAN_LOADERS.some((f) => hasFile(f));
  const gpu = nvidia || other;
  // Windows on Snapdragon runs this app as x64 (emulated); the engine runs natively as arm64.
  const arm = process.platform === "win32" && (/snapdragon|qualcomm/i.test(hw.cpu) || process.env.PROCESSOR_ARCHITEW6432 === "ARM64" || process.env.PROCESSOR_ARCHITECTURE === "ARM64");
  return {
    platform: process.platform,
    arch: arm ? "arm64" : process.arch,
    nvidia,
    vulkan: gpu && loader,
    ...(gpu && !loader ? { vulkanMissing: true } : {}),
    cpu: hw.cpu,
  };
}

/** The release files to download for this computer. */
export interface LlamaAssets {
  /** The llama.cpp binaries. */
  main: string;
  /** CUDA runtime libraries, needed next to the CUDA build on Windows and Linux. */
  runtime?: string;
  /** Human description, e.g. "Windows, CUDA 12". */
  label: string;
}

/**
 * Picks the llama.cpp release files for a platform. Release file names look
 * like `llama-b12110-bin-win-cuda-12.4-x64.zip`; matching ignores the build
 * number so new releases keep working.
 *
 * CUDA 12 is preferred over 13 on NVIDIA because it works with older drivers.
 * Without NVIDIA, Windows gets the Vulkan build (any GPU, falls back to CPU);
 * Linux gets Vulkan for AMD and Intel cards (and NVIDIA without a CUDA build),
 * otherwise the CPU build; macOS the Metal build; Windows on Snapdragon the
 * Adreno build when there is one, else Vulkan arm64.
 *
 * @param names - Asset file names of the release.
 * @param p - Platform facts.
 * @returns The files, or `undefined` if the platform has no build.
 */
export function pickLlamaAssets(names: string[], p: PlatformInfo): LlamaAssets | undefined {
  const find = (re: RegExp) => names.find((n) => re.test(n));
  const arch = p.arch === "arm64" ? "arm64" : "x64";
  const cuda = (os: "win" | "ubuntu") => {
    for (const major of ["12", "13"]) {
      const main = find(new RegExp(`^llama-b\\d+-bin-${os}-cuda-(${major}\\.[\\d.]+)-${arch}\\.(zip|tar\\.gz)$`));
      if (!main) continue;
      const version = /cuda-([\d.]+)-/.exec(main)?.[1] ?? "";
      const runtime = find(new RegExp(`^cudart-llama-(b\\d+-)?bin-${os}-cuda-${version.replace(/\./g, "\\.")}-${arch}\\.(zip|tar\\.gz)$`));
      return { main, ...(runtime ? { runtime } : {}), label: `CUDA ${version}` };
    }
    return undefined;
  };
  if (p.platform === "win32") {
    if (p.nvidia && arch === "x64") {
      const c = cuda("win");
      if (c) return { ...c, label: `Windows, NVIDIA ${c.label}` };
    }
    // Snapdragon: llama.cpp's build for its Adreno graphics (OpenCL), when the release has one.
    if (arch === "arm64" && /snapdragon|qualcomm/i.test(p.cpu ?? "")) {
      const adreno = find(/^llama-b\d+-bin-win-.*(opencl|adreno).*arm64\.zip$/i);
      if (adreno) return { main: adreno, label: "Windows on Snapdragon, Adreno (OpenCL)" };
    }
    const vulkan = find(new RegExp(`^llama-b\\d+-bin-win-vulkan-${arch}\\.zip$`));
    if (vulkan) return { main: vulkan, label: "Windows, Vulkan (any GPU)" };
    const cpu = find(new RegExp(`^llama-b\\d+-bin-win-cpu-${arch}\\.zip$`));
    return cpu ? { main: cpu, label: "Windows, CPU" } : undefined;
  }
  if (p.platform === "darwin") {
    const mac = find(new RegExp(`^llama-b\\d+-bin-macos-${arch}\\.(zip|tar\\.gz)$`));
    return mac ? { main: mac, label: `macOS ${arch === "arm64" ? "Apple Silicon (Metal)" : "Intel"}` } : undefined;
  }
  if (p.platform === "linux") {
    if (p.nvidia && arch === "x64") {
      const c = cuda("ubuntu");
      if (c) return { ...c, label: `Linux, NVIDIA ${c.label}` };
    }
    // AMD and Intel cards, and NVIDIA where there is no CUDA build (arm64 such as DGX Spark, or a release without
    // one): Vulkan, which their own drivers provide.
    if (p.vulkan ?? p.nvidia) {
      const vulkan = find(new RegExp(`^llama-b\\d+-bin-ubuntu-vulkan-${arch}\\.(zip|tar\\.gz)$`));
      if (vulkan) return { main: vulkan, label: `Linux, Vulkan (${p.nvidia ? "NVIDIA" : "AMD / Intel"} graphics card)` };
    }
    const cpu = find(new RegExp(`^llama-b\\d+-bin-ubuntu-${arch}\\.(zip|tar\\.gz)$`));
    return cpu ? { main: cpu, label: p.vulkanMissing ? "Linux, CPU (the graphics card needs Vulkan: install mesa-vulkan-drivers and libvulkan1, then update the engine)" : "Linux, CPU" } : undefined;
  }
  return undefined;
}

/** A GitHub release as far as the installer cares. */
interface Release {
  tag_name: string;
  body?: string;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
}

const GITHUB = "https://api.github.com/repos/ggml-org/llama.cpp/releases";

/**
 * Finds the newest llama.cpp release that has binaries. Stable releases
 * (`v0.9.0`) link to the nightly build (`b12110`) that carries the files;
 * older releases carry the files themselves.
 *
 * @param signal - Abort signal.
 * @returns The release with binaries.
 */
export async function findLlamaRelease(signal?: AbortSignal): Promise<Release> {
  const headers = { accept: "application/vnd.github+json", "user-agent": "KesherAI" };
  const get = async (url: string) => {
    const res = await fetch(url, { headers, signal });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url}`);
    return (await res.json()) as Release;
  };
  const latest = await get(`${GITHUB}/latest`);
  if (latest.assets.some((a) => a.name.includes("-bin-"))) return latest;
  const nightly = /Nightly build:\*?\*?\s*\[(b\d+)\]/i.exec(latest.body ?? "")?.[1];
  if (nightly) return get(`${GITHUB}/tags/${nightly}`);
  const recent = (await (await fetch(`${GITHUB}?per_page=10`, { headers, signal })).json()) as Release[];
  const withBins = recent.find((r) => r.assets.some((a) => a.name.includes("-bin-")));
  if (!withBins) throw new Error("Could not find a llama.cpp release with downloadable binaries");
  return withBins;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: "ignore" });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

/**
 * Unpacks a `.zip` or `.tar.gz`. Uses `tar`, which ships with Windows 10+,
 * macOS and Linux (and reads zip files on Windows and macOS); falls back to
 * `unzip` for zip files on Linux.
 *
 * @param archive - File to unpack.
 * @param dest - Target folder (created).
 */
export async function extractArchive(archive: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  try {
    await run("tar", ["-xf", archive, "-C", dest]);
  } catch (err) {
    if (!archive.endsWith(".zip")) throw err;
    await run("unzip", ["-o", "-q", archive, "-d", dest]);
  }
}

async function findFile(dir: string, name: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return full;
    if (e.isDirectory()) {
      const found = await findFile(full, name);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Waits for a download job to finish.
 *
 * @param dm - The download manager.
 * @param id - Job id.
 * @returns The finished job.
 * @throws Error if it failed or was cancelled.
 */
export function waitForDownload(dm: DownloadManager, id: string): Promise<DownloadJob> {
  return new Promise((resolve, reject) => {
    const on = (job: DownloadJob) => {
      if (job.id !== id) return;
      if (job.status === "done") {
        dm.off("update", on);
        resolve(job);
      } else if (job.status === "failed" || job.status === "cancelled") {
        dm.off("update", on);
        reject(new Error(job.error ?? `Download ${job.status}`));
      }
    };
    dm.on("update", on);
  });
}

/** What the UI shows about the built-in engine. */
export interface EngineStatus {
  installed: boolean;
  /** llama.cpp build installed, e.g. `b12110`. */
  version?: string;
  binaryPath?: string;
  running: boolean;
  /** GGUF file loaded. */
  modelPath?: string;
  /** What the engine is busy with, if anything. */
  job?: { phase: "installing" | "downloading-model" | "loading"; message: string } | { phase: "error"; message: string };
  /** Last lines of llama-server's output. */
  log: string[];
  /** How the graphics cards are used for the loaded model. */
  gpus?: string;
  /** Chats answered at the same time (the setting). */
  parallel: number;
  /** Slots the running server really has (fewer when memory was short). */
  runningParallel?: number;
  /** How fast the model last read a prompt, in tokens a second (slow means the graphics card is too full). */
  promptTps?: number;
  /** The context each chat gets (llama-server's n_ctx_slot). */
  slotTokens?: number;
  /** Multi-token prediction's guesses ahead (the setting; unset: llama.cpp's own). */
  mtpDraft?: number;
}

/**
 * KesherAI's built-in local engine: installs llama.cpp's `llama-server`
 * from the official GitHub releases (no LM Studio or Ollama needed), then
 * starts and stops it for one GGUF model at a time. The running server is
 * registered as the `llamacpp` provider by the core server.
 */
export class LlamaEngine {
  private proc?: ChildProcess;
  private modelPath?: string;
  private readonly log: string[] = [];
  private job?: EngineStatus["job"];

  /**
   * @param opts.dir - Folder engines are installed into.
   * @param opts.binaryPath - An already installed `llama-server`, if any.
   * @param opts.version - Its build tag.
   * @param opts.port - Port to serve on (localhost only).
   * @param opts.args - Extra arguments from the config.
   */
  constructor(
    private readonly opts: { dir: string; binaryPath?: string; version?: string; port: number; args: string[]; parallel?: number; mtpDraft?: number; fitTargetMiB?: number; kvType?: "f16" | "q8_0"; gpuPlan?: (modelPath: string) => Promise<GpuPlan> },
  ) {}

  /** @returns The engine's state. */
  status(): EngineStatus {
    const installed = !!this.opts.binaryPath && existsSync(this.opts.binaryPath);
    return {
      installed,
      ...(this.opts.version ? { version: this.opts.version } : {}),
      ...(installed ? { binaryPath: this.opts.binaryPath } : {}),
      running: !!this.proc && this.proc.exitCode === null,
      ...(this.modelPath ? { modelPath: this.modelPath } : {}),
      ...(this.job ? { job: this.job } : {}),
      log: this.log.slice(-60),
      ...(this.gpuSummary ? { gpus: this.gpuSummary } : {}),
      parallel: this.opts.parallel ?? 1,
      ...(this.runningParallel ? { runningParallel: this.runningParallel } : {}),
      ...(this.promptTps !== undefined && this.proc ? { promptTps: this.promptTps } : {}),
      ...(this.slotContext() ? { slotTokens: this.slotContext() } : {}),
      ...(this.opts.mtpDraft !== undefined ? { mtpDraft: this.opts.mtpDraft } : {}),
    };
  }

  /** @returns The running server's process id, if any. */
  get pid(): number | undefined {
    return this.proc && this.proc.exitCode === null ? this.proc.pid : undefined;
  }

  /** Slots the running server has (fewer than asked when memory was short). */
  private runningParallel = 0;

  /** Tokens each chat (slot) can hold, as llama-server reported it (`n_ctx_slot`). */
  private slotTokens?: number;

  /** @returns The context each chat gets on the running server, if it said. */
  slotContext(): number | undefined {
    return this.proc && this.proc.exitCode === null ? this.slotTokens : undefined;
  }

  /** The last prompt-reading speed llama-server reported (see {@link LlamaEngine.promptSpeed}). */
  private promptTps?: number;

  /**
   * The prompt-reading speed in a llama-server log line, if it has one.
   *
   * @param line - One line of output.
   * @returns Tokens a second, or undefined.
   */
  static promptSpeed(line: string): number | undefined {
    const m = /prompt (?:processing|eval time).*?([\d.]+) tokens per second/i.exec(line);
    return m ? Math.round(Number(m[1]) * 10) / 10 : undefined;
  }

  /**
   * Sets how many chats are answered at once; applies the next time a model loads.
   *
   * @param n - 1 to 8.
   */
  setParallel(n: number): void {
    this.opts.parallel = Math.min(8, Math.max(1, Math.round(n)));
  }

  /** @returns The OpenAI-compatible base URL of the running server. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.opts.port}/v1`;
  }

  /**
   * Shows progress in {@link status} while `work` runs; leaves an error
   * message there if it fails.
   *
   * @param phase - What is happening.
   * @param message - Shown to the user.
   * @param work - The work.
   * @returns What `work` returns.
   */
  async track<T>(phase: "installing" | "downloading-model" | "loading", message: string, work: () => Promise<T>): Promise<T> {
    this.job = { phase, message };
    try {
      const result = await work();
      this.job = undefined;
      return result;
    } catch (err) {
      this.job = { phase: "error", message: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  /**
   * Shows an error in {@link status} (for work done outside {@link track}).
   *
   * @param err - What went wrong.
   */
  fail(err: unknown): void {
    this.job = { phase: "error", message: err instanceof Error ? err.message : String(err) };
  }

  /**
   * Downloads and unpacks the right llama.cpp build for this computer.
   *
   * @param downloads - Where the download shows progress.
   * @param platform - Platform facts.
   * @returns The installed binary and its version.
   */
  async install(downloads: DownloadManager, platform: PlatformInfo): Promise<{ binaryPath: string; version: string; build?: string }> {
    return this.track("installing", "Finding the latest llama.cpp release…", async () => {
      const release = await findLlamaRelease();
      const picked = pickLlamaAssets(release.assets.map((a) => a.name), platform);
      if (!picked) throw new Error(`llama.cpp has no ready-made build for ${platform.platform}/${platform.arch}`);
      const target = join(this.opts.dir, "llama.cpp", release.tag_name);
      await rm(target, { recursive: true, force: true });
      for (const name of [picked.main, picked.runtime].filter((n): n is string => !!n)) {
        const asset = release.assets.find((a) => a.name === name)!;
        this.job = { phase: "installing", message: `Downloading llama.cpp ${release.tag_name} (${picked.label})…` };
        const archive = join(this.opts.dir, "downloads", name);
        const job = downloads.enqueue({ url: asset.browser_download_url, dest: archive, size: asset.size, label: `llama.cpp · ${name}` });
        await waitForDownload(downloads, job.id);
        this.job = { phase: "installing", message: "Unpacking…" };
        await extractArchive(archive, target);
        await rm(archive, { force: true });
      }
      const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
      const binaryPath = await findFile(target, exe);
      if (!binaryPath) throw new Error(`The download did not contain ${exe}`);
      if (process.platform !== "win32") await chmod(binaryPath, 0o755);
      this.opts.binaryPath = binaryPath;
      this.opts.version = release.tag_name;
      return { binaryPath, version: release.tag_name, build: picked.label };
    });
  }

  /**
   * The GPU part of the arguments. New llama.cpp builds fit the model to the memory that is free (with other models,
   * games or the editor using the card); "-ngl 99" turns that off and, when the card is full, Windows moves memory to
   * system RAM and everything crawls (found on the PC: self-work waited forever once the embedding model had loaded
   * next to Qwen3 Coder). So the old default "-ngl 99" is dropped on builds that fit by themselves (b7400 and newer),
   * and kept for older ones, which put nothing on the GPU without it.
   *
   * @param args - Arguments from the config.
   * @param version - The build tag, e.g. `b12110`.
   * @returns The arguments to use.
   */
  static gpuArgs(args: readonly string[], version?: string): string[] {
    const fits = LlamaEngine.fits(version);
    const oldDefault = args.length === 2 && args[0] === "-ngl" && args[1] === "99";
    if (fits && oldDefault) return [];
    if (!fits && !args.some((a) => a === "-ngl" || a === "--n-gpu-layers" || a === "--gpu-layers")) return [...args, "-ngl", "99"];
    return [...args];
  }

  /**
   * The sampling settings a model's makers recommend, as server defaults (a chat or persona that sets its own still
   * wins). llama-server's own defaults (temperature 0.8, top-k 40, min-p 0.05) are tuned for chat, not for code.
   *
   * @param modelPath - The model file.
   * @param args - Arguments from the config (a setting given there is kept).
   * @returns Arguments to add.
   */
  static samplingArgs(modelPath: string, args: readonly string[] = []): string[] {
    const name = basename(modelPath).toLowerCase();
    // Qwen3.5/3.6 model cards: thinking mode for precise coding. Qwen3 Coder's card: temperature 0.7, top-p 0.8.
    // Qwen3.8's card: thinking mode at temperature 1.0 (top-p 0.95, top-k 20, min-p 0).
    const rec = /qwen3\.[89]/.test(name)
      ? { "--temp": "1.0", "--top-p": "0.95", "--top-k": "20", "--min-p": "0" }
      : /qwen3\.[5-7]/.test(name)
      ? { "--temp": "0.6", "--top-p": "0.95", "--top-k": "20", "--min-p": "0" }
      : /qwen3-coder/.test(name)
        ? { "--temp": "0.7", "--top-p": "0.8", "--top-k": "20", "--min-p": "0", "--repeat-penalty": "1.05" }
        : undefined;
    if (!rec) return [];
    const aliases: Record<string, string[]> = { "--temp": ["--temp", "--temperature"], "--top-p": ["--top-p"], "--top-k": ["--top-k"], "--min-p": ["--min-p"], "--repeat-penalty": ["--repeat-penalty"] };
    return Object.entries(rec).flatMap(([k, v]) => (aliases[k]!.some((a) => args.includes(a)) ? [] : [k, v]));
  }

  /**
   * Arguments for hybrid models (Qwen3.5–3.8, Qwen3-Next: recurrent Gated DeltaNet layers). Their state cannot be
   * rolled back, so after a change in the middle of a conversation llama-server resumes from the nearest saved
   * checkpoint, by default at least 8,192 tokens apart. Closer checkpoints (1,024) mean far less to read again on
   * each agent step, for some system memory (see docs/RESEARCH_LOG.md: 53 s per step was found on the PC).
   *
   * @param modelPath - The model file.
   * @param args - Arguments from the config (a setting given there is kept).
   * @param version - The build tag (the flag is in b12110; older builds get nothing).
   * @returns Arguments to add.
   */
  static hybridArgs(modelPath: string, args: readonly string[] = [], version?: string): string[] {
    const build = Number(/^b(\d+)$/.exec(version ?? "")?.[1] ?? 0);
    if (build < 12000 || !/qwen3\.[5-9]|qwen3-?next/i.test(basename(modelPath))) return [];
    return args.some((a) => a === "-cms" || a === "--checkpoint-min-step") ? [] : ["--checkpoint-min-step", "1024"];
  }

  /**
   * `--spec-type draft-mtp` for a model file that has an MTP head, on builds that have it (b12000+), unless the
   * config sets its own speculative decoding.
   *
   * @param modelPath - The model file.
   * @param args - Arguments from the config.
   * @param version - The build tag.
   * @param draft - Tokens guessed ahead (`--spec-draft-n-max`); 0 turns it off.
   * @returns Arguments to add.
   */
  static async mtpArgs(modelPath: string, args: readonly string[] = [], version?: string, draft?: number): Promise<string[]> {
    const build = Number(/^b(\d+)$/.exec(version ?? "")?.[1] ?? 0);
    if (build < 12000 || args.some((a) => a.startsWith("--spec") || a === "-md" || a === "--model-draft")) return [];
    if (draft === 0 || !((await mtpLayers(modelPath)) > 0)) return [];
    // How many tokens it guesses ahead: fewer guesses are checked faster and use less memory (2 was fastest on a
    // 24 GB card at Q4 in a published test; see docs/RESEARCH_LOG.md).
    // Unset: 2. On the PC (Qwen3.8-27B Q4, 24 GB, two chats at once) it wrote as fast as llama.cpp's own number
    // (62-69 tok/s) and left each chat 49K tokens instead of 45.5K.
    return ["--spec-type", "draft-mtp", "--spec-draft-n-max", String(draft ?? 2)];
  }

  /** Multi-token prediction's guesses ahead (undefined: 2; 0: off). */
  setMtpDraft(n: number | undefined): void {
    if (n === undefined) delete this.opts.mtpDraft;
    else this.opts.mtpDraft = Math.min(16, Math.max(0, Math.round(n)));
  }

  /**
   * How much graphics memory fitting leaves free (MiB): room for a game or the Unreal/Unity editor on the same card.
   *
   * @param mib - The margin; undefined for the default (2 GB).
   */
  setFitTarget(mib: number | undefined): void {
    if (mib === undefined) delete this.opts.fitTargetMiB;
    else this.opts.fitTargetMiB = Math.min(16384, Math.max(512, Math.round(mib)));
  }

  /**
   * The context memory's type: 8 bits (default: twice the context in the same memory) or 16 bits (faster on some
   * cards). Chosen by calibration (calibrate.ts) or by the user.
   *
   * @param t - "q8_0", "f16", or undefined for the default.
   */
  setKvType(t: "f16" | "q8_0" | undefined): void {
    if (t === undefined) delete this.opts.kvType;
    else this.opts.kvType = t;
  }

  /**
   * Measures a model with llama-bench: reading 512 and writing 64 tokens, twice each, at the given depths, with
   * flash attention and the context memory type given. The chat model should be unloaded first (the whole card).
   *
   * @param modelPath - The GGUF file.
   * @param kv - Context memory type.
   * @param depths - Tokens already in the context.
   * @param signal - Stops it.
   * @returns llama-bench's JSON output.
   */
  async bench(modelPath: string, kv: "f16" | "q8_0", depths: number[], signal?: AbortSignal): Promise<string> {
    const binary = this.opts.binaryPath;
    if (!binary || !existsSync(binary)) throw new Error("The llama.cpp engine is not installed yet. Install it from the Models screen.");
    const tool = join(dirname(binary), basename(binary).replace(/llama-server/, "llama-bench"));
    if (!existsSync(tool)) throw new Error("This llama.cpp build has no llama-bench.");
    const args = ["-m", modelPath, "-p", "512", "-n", "64", "-r", "2", "-fa", "1", "-ctk", kv, "-ctv", kv, "-d", depths.join(","), "-o", "json"];
    return await new Promise<string>((resolve, reject) => {
      const p = spawn(tool, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      p.stdout.on("data", (d: Buffer) => (out += d.toString()));
      const stop = () => p.kill();
      signal?.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, 15 * 60_000);
      p.once("error", (e) => (clearTimeout(timer), reject(e)));
      p.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        if (signal?.aborted) reject(new Error("Stopped."));
        else if (code !== 0 && !out.includes("[")) reject(new Error(`llama-bench stopped (code ${code}); the setup may not fit in memory.`));
        else resolve(out);
      });
    });
  }

  /**
   * What llama.cpp will do with a model before loading it: runs llama-fit-params (same fitting as llama-server's
   * start, test allocations only) with the arguments this engine would use. See fit-preview.ts.
   *
   * @param modelPath - The GGUF file.
   * @returns The plan.
   * @throws Error when the engine or its fit tool is not installed, or the build has no fitting.
   */
  async fitPreview(modelPath: string): Promise<FitPlan> {
    const binary = this.opts.binaryPath;
    if (!binary || !existsSync(binary)) throw new Error("The llama.cpp engine is not installed yet. Install it from the Models screen.");
    if (!LlamaEngine.fits(this.opts.version)) throw new Error("This llama.cpp build cannot plan the memory ahead (update the engine).");
    const tool = join(dirname(binary), basename(binary).replace(/llama-server/, "llama-fit-params"));
    if (!existsSync(tool)) throw new Error("This llama.cpp build has no llama-fit-params.");
    const args = ["-m", modelPath, ...LlamaEngine.serverArgs(LlamaEngine.gpuArgs(this.opts.args, this.opts.version), false, this.opts.parallel ?? 1, true, this.opts.fitTargetMiB, this.opts.kvType), ...LlamaEngine.hybridArgs(modelPath, this.opts.args, this.opts.version)];
    const t0 = Date.now();
    return await new Promise<FitPlan>((resolve, reject) => {
      const p = spawn(tool, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let log = "";
      p.stdout.on("data", (d: Buffer) => (out += d.toString()).length > 100_000 && p.kill());
      // Only the lines the plan needs (the full log is long).
      let rest = "";
      p.stderr.on("data", (d: Buffer) => {
        const lines = (rest + d.toString()).split("\n");
        rest = lines.pop() ?? "";
        for (const l of lines) if (/n_layer|MiB used|fit params|failed to fit/.test(l)) log += `${l}\n`;
      });
      const timer = setTimeout(() => p.kill(), 120_000);
      p.once("error", (e) => (clearTimeout(timer), reject(e)));
      p.once("close", () => {
        clearTimeout(timer);
        resolve(parseFit(log + rest, out, Date.now() - t0));
      });
    });
  }

  /**
   * Whether a build fits the model to the free memory by itself (`--fit`, on by default since b7400).
   *
   * @param version - The build tag, e.g. `b12110`.
   */
  static fits(version?: string): boolean {
    return Number(/^b(\d+)$/.exec(version ?? "")?.[1] ?? 0) >= 7400;
  }

  /**
   * How long loading a model file may take.
   *
   * @param bytes - Size of the file.
   * @returns Milliseconds: at least 5 minutes.
   */
  static loadTimeout(bytes: number): number {
    // A big model read from a slow disk (or another app's folder on a hard drive) takes minutes: about 30 MB/s at worst.
    return Math.max(300_000, Math.round(bytes / (30 * 1024 ** 2)) * 1000);
  }

  /**
   * The arguments llama-server gets: the config's, plus `--jinja` (needed
   * for tool calling), slots for chats answered at the same time, and a
   * context that gives each of them room (32k for one, 16k more per extra
   * chat, kept at 8 bits) unless the config sets its own.
   *
   * @param extra - Arguments from the config.
   * @param withJinja - Whether to add `--jinja`.
   * @param parallel - Chats answered at once.
   * @param fits - Whether the build fits the model to memory by itself (see gpuArgs).
   * @param fitTargetMiB - Graphics memory to leave free when fitting (default 2 GB; see setFitTarget).
   * @param kvType - The context memory's type (default 8 bits; see setKvType).
   * @returns The full argument list besides model, host and port.
   */
  static serverArgs(extra: string[], withJinja = true, parallel = 1, fits = false, fitTargetMiB = 2048, kvType: "f16" | "q8_0" = "q8_0"): string[] {
    const args = [...extra];
    if (withJinja && !args.includes("--jinja")) args.push("--jinja");
    const own = args.some((a) => a === "-np" || a === "--parallel");
    if (parallel > 1 && !own) args.push("-np", String(parallel));
    if (!args.some((a) => a === "-c" || a === "--ctx-size")) {
      // Builds that fit: no -c, so llama.cpp starts from the model's own context and shrinks it only as far as the
      // free memory needs, before it moves any layer off the GPU (common/fit.cpp: step 2, then step 3). Models whose
      // context costs little memory (Qwen3.6: attention in only 16 of 64 layers) then get 100K+ per chat on one card
      // instead of a fixed 24K. Each chat keeps at least 32K (--fit-ctx is per chat).
      if (fits) args.push("--fit-ctx", "32768");
      // fit leaves 1 GB free by default; with the context grown to fill the card, Windows then moved memory to system
      // RAM at run time and the model wrote at half speed (found on the PC: 0.5 GB left, 18 instead of 40 tokens/s).
      if (fits && !args.some((a) => a === "-fitt" || a === "--fit-target")) args.push("--fit-target", String(fitTargetMiB));
      // Older builds: room for coding agents (their instructions and tools alone are thousands of tokens): 32K, 16K more per extra chat.
      else args.push("-c", String(32768 + 16384 * (own ? 0 : parallel - 1)));
    }
    // The context's memory at 8 bits (half of the default 16), so the bigger context fits next to the model.
    if (!args.some((a) => a.startsWith("--cache-type") || a === "-ctk" || a === "-ctv")) args.push("--cache-type-k", kvType, "--cache-type-v", kvType);
    return args;
  }

  /**
   * Starts llama-server with a model and waits until it answers.
   *
   * @param modelPath - Absolute path of a `.gguf` file.
   * @param timeoutMs - How long loading may take (by default 5 minutes, more for big files: see loadTimeout).
   * @throws Error if the engine is not installed, or the server exits or does not become ready.
   */
  async load(modelPath: string, timeoutMs?: number): Promise<void> {
    timeoutMs ??= LlamaEngine.loadTimeout((await stat(modelPath).catch(() => undefined))?.size ?? 0);
    const binary = this.opts.binaryPath;
    if (!binary || !existsSync(binary)) throw new Error("The llama.cpp engine is not installed yet. Install it from the Models screen.");
    const plan = userChoseGpus(this.opts.args) ? undefined : await this.opts.gpuPlan?.(modelPath).catch(() => undefined);
    this.gpuSummary = plan?.summary ?? "";
    const gpuArgs = plan?.args ?? [];
    await this.track("loading", `Loading ${basename(modelPath)}…${plan?.summary ? ` ${plan.summary}.` : ""}`, async () => {
      const parallel = this.opts.parallel ?? 1;
      let failure: unknown;
      // Multi-token prediction: a model that carries its own MTP head (Qwen3.5–3.8 GGUFs with NextN tensors) guesses
      // a few tokens ahead and the main model checks them, so it writes faster. Only on builds that have it, and
      // dropped again if the server will not start with it.
      let mtp = await LlamaEngine.mtpArgs(modelPath, this.opts.args, this.opts.version, this.opts.mtpDraft);
      // Several chats at once need more memory for their context; if that does not fit, one at a time may.
      for (const p of parallel > 1 ? [parallel, 1] : [1]) {
        try {
          await this.start(binary, modelPath, [...LlamaEngine.serverArgs(LlamaEngine.gpuArgs(this.opts.args, this.opts.version), true, p, LlamaEngine.fits(this.opts.version), this.opts.fitTargetMiB, this.opts.kvType), ...gpuArgs, ...LlamaEngine.samplingArgs(modelPath, this.opts.args), ...LlamaEngine.hybridArgs(modelPath, this.opts.args, this.opts.version), ...mtp], timeoutMs, plan?.env);
          this.runningParallel = p;
          return;
        } catch (err) {
          failure = err;
          if (mtp.length) {
            mtp = [];
            try {
              await this.start(binary, modelPath, [...LlamaEngine.serverArgs(LlamaEngine.gpuArgs(this.opts.args, this.opts.version), true, p, LlamaEngine.fits(this.opts.version)), ...gpuArgs, ...LlamaEngine.samplingArgs(modelPath, this.opts.args), ...LlamaEngine.hybridArgs(modelPath, this.opts.args, this.opts.version)], timeoutMs, plan?.env);
              this.log.push("KesherAI: started without multi-token prediction (the engine refused it).");
              this.runningParallel = p;
              return;
            } catch (err3) {
              failure = err3;
            }
          }
          // Builds that predate --jinja (or where it became the default and the flag was removed) reject it.
          if (!/jinja/i.test(this.log.join("\n"))) continue;
          try {
            await this.start(binary, modelPath, [...LlamaEngine.serverArgs(LlamaEngine.gpuArgs(this.opts.args, this.opts.version), false, p, LlamaEngine.fits(this.opts.version)), ...gpuArgs, ...LlamaEngine.samplingArgs(modelPath, this.opts.args), ...LlamaEngine.hybridArgs(modelPath, this.opts.args, this.opts.version)], timeoutMs, plan?.env);
            this.runningParallel = p;
            return;
          } catch (err2) {
            failure = err2;
          }
        }
      }
      throw failure;
    });
  }

  /** How the cards are used for the loaded model, e.g. "Split across … ; … leads". */
  gpuSummary = "";

  private async start(binary: string, modelPath: string, args: string[], timeoutMs: number, env?: Record<string, string>): Promise<void> {
    await this.stop();
    this.log.length = 0;
    // Another app (another llama-server, a dev server…) may already hold the port: then the health check talks to it and
    // the load never finishes. Move to a free port and say so.
    if (await portTaken(this.opts.port)) {
      const before = this.opts.port;
      this.opts.port = await freePort();
      this.log.push(`KesherAI: port ${before} is used by another app, so the engine uses port ${this.opts.port}.`);
    }
    const alias = basename(modelPath).replace(/\.gguf$/i, "");
    const proc = spawn(binary, ["-m", modelPath, "--host", "127.0.0.1", "--port", String(this.opts.port), "--alias", alias, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    this.proc = proc;
    this.modelPath = modelPath;
    this.promptTps = undefined;
    this.slotTokens = undefined;
    const onData = (buf: Buffer) => {
      const lines = buf.toString().split(/\r?\n/).filter(Boolean);
      for (const l of lines) {
        this.promptTps = LlamaEngine.promptSpeed(l) ?? this.promptTps;
        const slot = /n_ctx_slot = (\d+)/.exec(l)?.[1];
        if (slot) this.slotTokens = Number(slot);
      }
      this.log.push(...lines);
      if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    // Say when it ends, and why if KesherAI ended it (the status shows the log): a silent stop looked like a crash.
    proc.once("exit", (code, signal) => this.log.push(`KesherAI: llama-server ended (${signal ? `stopped: ${this.stopReason ?? signal}` : `exit code ${code}`}).`));
    const spawnError = new Promise<never>((_, reject) => proc.once("error", reject));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        this.proc = undefined;
        this.modelPath = undefined;
        throw new Error(`llama-server stopped (code ${proc.exitCode}): ${this.log.slice(-4).join(" | ")}`);
      }
      const ok = await Promise.race([
        fetch(`http://127.0.0.1:${this.opts.port}/health`).then((r) => r.ok).catch(() => false),
        spawnError,
      ]);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    const last = this.log.slice(-2).join(" | ");
    await this.stop();
    throw new Error(`llama-server did not become ready in ${Math.round(timeoutMs / 60_000)} minutes${last ? `; it last said: ${last}` : ""}`);
  }

  /** Why the server was last stopped (shown in its log). */
  private stopReason?: string;

  /**
   * Stops the server if it runs.
   *
   * @param reason - Why, for the log (e.g. "unused for 20 minutes").
   */
  async stop(reason?: string): Promise<void> {
    this.stopReason = reason;
    const proc = this.proc;
    this.proc = undefined;
    this.modelPath = undefined;
    if (!proc || proc.exitCode !== null) return;
    proc.kill();
    await new Promise((r) => {
      const t = setTimeout(() => {
        proc.kill("SIGKILL");
        r(undefined);
      }, 5000);
      proc.once("exit", () => {
        clearTimeout(t);
        r(undefined);
      });
    });
  }
}

/**
 * Whether something on this computer already uses a port: it answers there,
 * or the port cannot be taken.
 *
 * @param port - Port on 127.0.0.1.
 * @returns True if taken.
 */
export async function portTaken(port: number): Promise<boolean> {
  const answers = await new Promise<boolean>((done) => {
    const c = createConnection({ host: "127.0.0.1", port });
    c.setTimeout(800);
    c.once("connect", () => (c.destroy(), done(true)));
    c.once("timeout", () => (c.destroy(), done(false)));
    c.once("error", () => done(false));
  });
  if (answers) return true;
  return new Promise<boolean>((done) => {
    const srv = createServer();
    srv.once("error", () => done(true));
    srv.listen({ host: "127.0.0.1", port, exclusive: true }, () => srv.close(() => done(false)));
  });
}

/** @returns A port nothing on 127.0.0.1 uses right now. */
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen({ host: "127.0.0.1", port: 0 }, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => done(port));
    });
  });
}
