import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ModelInfo } from "@kesher/shared";
import type { GeneratedFile, Provider, ProviderImageRequest } from "@kesher/providers";
import { listHubFiles, type DownloadManager } from "@kesher/downloads";
import { extractArchive, waitForDownload } from "./llamacpp.js";

/**
 * The built-in image engine: stable-diffusion.cpp (MIT licence).
 *
 * Like the llama.cpp engine, KesherAI downloads the right build for this
 * computer the first time it is needed, and runs `sd-cli` for each image.
 * It runs the image models in KesherAI's `models/image` folder: SD 1.5 and
 * SDXL checkpoints, Flux, and Qwen-Image. Flux and Qwen-Image need extra
 * files (a VAE and text encoders), which KesherAI downloads by itself the
 * first time, from the repositories named in {@link FAMILIES}.
 */

const RELEASES = "https://api.github.com/repos/leejet/stable-diffusion.cpp/releases";

/** The Vulkan driver reset the card ("device lost"). */
export const DEVICE_LOST = /DeviceLost|DEVICE_LOST|vk::.*ErrorDevice/i;

/** ggml's switches for a gentler Vulkan run: no cooperative-matrix or integer-dot shaders (newer cards' fast paths). */
const GENTLE_VULKAN: Record<string, string> = { GGML_VK_DISABLE_COOPMAT: "1", GGML_VK_DISABLE_COOPMAT2: "1", GGML_VK_DISABLE_INTEGER_DOT_PRODUCT: "1" };

/** Keeps each "--x-on-cpu" flag once (memory flags and the gentle mode can both add one). */
export function dedupeCpuFlags(args: string[]): string[] {
  const seen = new Set<string>();
  return args.filter((a) => !(/^--[a-z-]+-on-cpu$/.test(a) && (seen.has(a) || !seen.add(a))));
}

/** A file a model family needs besides the model itself. */
interface Companion {
  /** Command-line flag, e.g. `--vae`. */
  flag: string;
  repo: string;
  path: string;
  /** Approximate size, shown to the user. */
  sizeGb: number;
}

/** How to run one kind of image model. */
export interface ModelFamily {
  id: string;
  name: string;
  /** Matches the file name. */
  match: RegExp;
  /** How the model file is passed: a full checkpoint (`-m`) or only the diffusion part. */
  modelFlag: "-m" | "--diffusion-model";
  companions: Companion[];
  /** Extra arguments, e.g. the sampler. */
  args: string[];
  steps: number;
  cfg: number;
  /** Video models (Wan): frames per clip and frame rate. */
  video?: { frames: number; fps: number; width: number; height: number };
}

/**
 * Model families. Companion repositories are the ones the
 * stable-diffusion.cpp and Unsloth guides use.
 */
export const FAMILIES: ModelFamily[] = [
  {
    // Wan 2.1 text-to-video (1.3B: fast, ~8 GB of graphics memory at 480p).
    id: "wan",
    name: "Wan video",
    match: /wan2[._]?[12]/i,
    modelFlag: "--diffusion-model",
    companions: [
      { flag: "--vae", repo: "Comfy-Org/Wan_2.1_ComfyUI_repackaged", path: "split_files/vae/wan_2.1_vae.safetensors", sizeGb: 0.25 },
      { flag: "--t5xxl", repo: "city96/umt5-xxl-encoder-gguf", path: "umt5-xxl-encoder-Q5_K_M.gguf", sizeGb: 4.15 },
    ],
    args: ["--sampling-method", "euler", "--flow-shift", "3.0", "--diffusion-fa"],
    steps: 30,
    cfg: 6,
    video: { frames: 33, fps: 16, width: 832, height: 480 },
  },
  {
    id: "qwen-image",
    name: "Qwen-Image",
    match: /qwen[-_ ]?image/i,
    modelFlag: "--diffusion-model",
    companions: [
      { flag: "--vae", repo: "Comfy-Org/Qwen-Image_ComfyUI", path: "split_files/vae/qwen_image_vae.safetensors", sizeGb: 0.25 },
      { flag: "--llm", repo: "unsloth/Qwen2.5-VL-7B-Instruct-GGUF", path: "Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL.gguf", sizeGb: 5 },
    ],
    args: ["--sampling-method", "euler", "--flow-shift", "3", "--diffusion-fa"],
    steps: 20,
    cfg: 2.5,
  },
  {
    id: "flux",
    name: "Flux",
    match: /flux/i,
    modelFlag: "--diffusion-model",
    companions: [
      { flag: "--vae", repo: "second-state/FLUX.1-schnell-GGUF", path: "ae.safetensors", sizeGb: 0.33 },
      { flag: "--clip_l", repo: "second-state/FLUX.1-schnell-GGUF", path: "clip_l.safetensors", sizeGb: 0.25 },
      { flag: "--t5xxl", repo: "second-state/FLUX.1-schnell-GGUF", path: "t5xxl-Q8_0.gguf", sizeGb: 5 },
    ],
    args: ["--sampling-method", "euler", "--diffusion-fa"],
    steps: 20,
    cfg: 1,
  },
  {
    id: "checkpoint",
    name: "Stable Diffusion (SD 1.5 / SDXL)",
    match: /\.(safetensors|ckpt|gguf)$/i,
    modelFlag: "-m",
    companions: [],
    args: ["--sampling-method", "euler_a"],
    steps: 20,
    cfg: 7,
  },
];

/**
 * Picks the family for a model file.
 *
 * @param file - Model file name or path.
 * @returns The family, with fewer steps for distilled "turbo", "lightning" and "schnell" models.
 */
export function familyFor(file: string): ModelFamily {
  const name = basename(file);
  const f = FAMILIES.find((x) => x.match.test(name)) ?? FAMILIES[FAMILIES.length - 1]!;
  if (/turbo|lightning|schnell|distill/i.test(name)) return { ...f, steps: /schnell/i.test(name) ? 4 : 8, cfg: f.id === "checkpoint" ? 1.5 : 1 };
  return f;
}

/**
 * Picks the stable-diffusion.cpp download for this computer.
 *
 * @param names - Release file names.
 * @param target - Platform, architecture and whether there is an NVIDIA GPU.
 * @returns The engine archive and, for CUDA builds, the CUDA runtime archive if the release has one.
 */
export function pickSdAssets(names: string[], target: { platform: string; arch: string; nvidia: boolean }): { engine: string; extra?: string } | undefined {
  const find = (re: RegExp) => names.find((n) => re.test(n));
  if (target.platform === "win32") {
    const cuda = target.nvidia ? find(/bin-win-cuda12-x64\.zip$/i) : undefined;
    if (cuda) {
      const rt = find(/cudart.*win.*cu(da)?12.*x64\.zip$/i);
      return { engine: cuda, ...(rt ? { extra: rt } : {}) };
    }
    const e = find(/bin-win-vulkan-x64\.zip$/i) ?? find(/bin-win-avx2-x64\.zip$/i) ?? find(/bin-win-.*x64\.zip$/i);
    return e ? { engine: e } : undefined;
  }
  if (target.platform === "darwin") {
    const e = find(new RegExp(`bin-Darwin-.*${target.arch === "arm64" ? "arm64" : "x86_64"}\\.zip$`, "i"));
    return e ? { engine: e } : undefined;
  }
  const e = find(/bin-Linux-.*x86_64-vulkan\.zip$/i) ?? find(/bin-Linux-.*x86_64\.zip$/i);
  return e ? { engine: e } : undefined;
}

/**
 * @param dir - Folder to search (recursively).
 * @param name - File name, any case.
 * @returns The first match, or `undefined`.
 */
export async function findFile(dir: string, name: string): Promise<string | undefined> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return full;
    if (e.isDirectory()) {
      const f = await findFile(full, name);
      if (f) return f;
    }
  }
  return undefined;
}

/**
 * Whether a file is in Apple's MLX format (runs only on Apple Silicon Macs, not in stable-diffusion.cpp or llama.cpp).
 *
 * @param path - File path or repo and file name.
 * @returns True for MLX.
 */
export function isMlx(path: string): boolean {
  return /(^|[-_./ ])mlx([-_./ ]|$)/i.test(path);
}

/** Image models that run in the built-in engine, offered under Models → Images. */
export const RECOMMENDED_IMAGE_MODELS = [
  { id: "qwen-image-2512", name: "Qwen-Image 2512", repo: "unsloth/Qwen-Image-2512-GGUF", file: "qwen-image-2512-Q4_K_M.gguf", note: { en: "The best quality, and good at text inside images. Needs a strong GPU (12 GB+ is comfortable).", he: "האיכות הגבוהה ביותר, וטוב בטקסט בתוך תמונות. צריך כרטיס חזק (12 GB ומעלה בנוח)." } },
  { id: "flux-schnell", name: "FLUX.1 schnell", repo: "second-state/FLUX.1-schnell-GGUF", file: "flux1-schnell-Q4_0.gguf", note: { en: "Fast: a good image in 4 steps. Works well on 8 GB GPUs.", he: "מהיר: תמונה טובה ב-4 צעדים. עובד טוב על כרטיסים של 8 GB." } },
] as const;

/** Thrown when the engine or a model's extra files are still downloading. */
export class PreparingError extends Error {}

/** What the image engine is doing right now, for the chat's progress line. */
export interface ImageProgress {
  /** `loading` the model files, `encoding` the prompt, `sampling` (the steps), `decoding` the picture. */
  phase: "loading" | "encoding" | "sampling" | "decoding";
  step?: number;
  steps?: number;
  /** Seconds per step, as the engine reports it. */
  secondsPerStep?: number;
  startedAt: number;
  /** Whether the engine runs on the GPU (CUDA) or fell back to the processor. */
  device?: "gpu" | "cpu";
}

/**
 * Reads stable-diffusion.cpp's console output into a progress update.
 *
 * @param text - Output so far (progress bars are redrawn with `\r`).
 * @param prev - The previous state.
 * @returns The new state.
 */
export function progressFrom(text: string, prev: ImageProgress): ImageProgress {
  const next: ImageProgress = { ...prev };
  if (/ggml_cuda_init|CUDA devices|using CUDA backend/i.test(text)) next.device = "gpu";
  else if (!next.device && /using CPU backend/i.test(text)) next.device = "cpu";
  if (/get_learned_condition|text encoder|conditioner/i.test(text) && next.phase === "loading") next.phase = "encoding";
  if (/sampling|generating image/i.test(text) && (next.phase === "loading" || next.phase === "encoding")) next.phase = "sampling";
  const bars = [...text.matchAll(/\|\s*(\d+)\/(\d+)\s*-\s*([\d.]+)\s*(s\/it|it\/s)/g)];
  const last = bars.at(-1);
  if (last) {
    next.phase = "sampling";
    next.step = Number(last[1]);
    next.steps = Number(last[2]);
    const v = Number(last[3]);
    next.secondsPerStep = last[4] === "it/s" ? (v > 0 ? 1 / v : undefined) : v;
  }
  if (/decode_first_stage|decoding|vae.*(decode|tiling)/i.test(text.slice(-600)) && next.step && next.step === next.steps) next.phase = "decoding";
  return next;
}

/** Runs stable-diffusion.cpp and owns its files. */
export class SdEngine {
  private installing?: Promise<string>;
  private preparing = new Map<string, Promise<void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private current?: ImageProgress;
  /** The card the next run uses (the fastest allowed one). */
  private lastCard?: number;

  /** @returns What the engine is doing now, or `undefined` when idle. */
  progress(): ImageProgress | undefined {
    return this.current;
  }

  /**
   * Flags that keep the run inside the graphics card's own memory. On
   * Windows, a model that overflows it spills into "shared GPU memory"
   * (normal RAM over PCIe), which makes every step many times slower
   * instead of failing. So when the files do not fit with room to spare,
   * the text encoder runs on the processor and the weights are swapped in
   * per stage; the picture is always decoded in tiles.
   *
   * @param modelFile - Main model file.
   * @param family - Its family.
   * @returns Extra command-line flags.
   */
  private async memoryArgs(modelFile: string, family: ModelFamily): Promise<string[]> {
    const args = ["--vae-tiling"];
    const { nvidia, vramGb, cudaIndex } = await this.gpu().catch(() => ({ nvidia: false, vramGb: undefined, cudaIndex: undefined }));
    this.lastCard = cudaIndex;
    if (!nvidia || !vramGb) return args;
    const sizes = await Promise.all([modelFile, ...family.companions.map((c) => this.companionPath(c))].map((f) => stat(f).then((x) => x.size, () => 0)));
    const totalGb = sizes.reduce((a, b) => a + b, 0) / 1024 ** 3;
    const headroom = 3.5; // working memory for 1024×1024
    if (totalGb + headroom > vramGb) {
      const encoderGb = sizes.slice(1).reduce((a, b) => a + b, 0) / 1024 ** 3;
      if (family.companions.length && totalGb - encoderGb + headroom <= vramGb) args.push("--clip-on-cpu");
      else args.push("--offload-to-cpu");
    }
    return args;
  }

  /** Where the last run's full console output is saved (for troubleshooting). */
  get logFile(): string {
    return join(this.dir, "last-run.log");
  }

  /**
   * @param dir - Engine folder (inside KesherAI's engines folder).
   * @param modelsDir - Returns KesherAI's models folder.
   * @param downloads - The download queue.
   * @param gpu - Whether this computer has an NVIDIA GPU (picks the CUDA build) and its memory.
   */
  constructor(
    private readonly dir: string,
    private readonly modelsDir: () => string,
    private readonly downloads: DownloadManager,
    private readonly gpu: () => Promise<{ nvidia: boolean; vramGb?: number; cudaIndex?: number }>,
  ) {}

  private get imageDir(): string {
    return join(this.modelsDir(), "image");
  }

  /** Where LoRA files go; a prompt names them as `<lora:name:weight>`. */
  get loraDir(): string {
    return join(this.modelsDir(), "loras");
  }

  /** @returns The LoRA files in `models/loras`, by name (the file name without its extension). */
  async loras(): Promise<Array<{ name: string; file: string; size: number }>> {
    const out: Array<{ name: string; file: string; size: number }> = [];
    for (const e of await readdir(this.loraDir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isFile() || !/\.(safetensors|gguf|ckpt|pt)$/i.test(e.name)) continue;
      const st = await stat(join(this.loraDir, e.name)).catch(() => undefined);
      out.push({ name: e.name.replace(/\.[^.]+$/, ""), file: e.name, size: st?.size ?? 0 });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Deletes a LoRA file by name. */
  async removeLora(name: string): Promise<boolean> {
    const lora = (await this.loras()).find((l) => l.name === name);
    if (!lora) return false;
    await rm(join(this.loraDir, lora.file));
    return true;
  }

  /** The upscaler (Real-ESRGAN, BSD-3), from its author's release. */
  private get upscalerPath(): string {
    return join(this.supportDir, "esrgan", "RealESRGAN_x4plus_anime_6B.pth");
  }

  /** @returns Whether upscaling can run now, and the size of what it still needs. */
  async upscaleStatus(): Promise<{ ready: boolean; engineInstalled: boolean; modelMb: number; busy: boolean }> {
    const engineInstalled = !!(await findFile(this.dir, process.platform === "win32" ? "sd-cli.exe" : "sd-cli"));
    const model = existsSync(this.upscalerPath);
    return { ready: engineInstalled && model, engineInstalled, modelMb: model ? 0 : 18, busy: !!this.preparingUpscaler };
  }

  private preparingUpscaler: Promise<void> | undefined;

  /** Downloads the engine and the upscaler the first time (follow it in the downloads circle). */
  prepareUpscaler(): Promise<void> {
    this.preparingUpscaler ??= (async () => {
      await this.install();
      if (existsSync(this.upscalerPath)) return;
      const job = this.downloads.enqueue({ url: UPSCALER_URL, dest: this.upscalerPath, label: "Image upscaler · RealESRGAN_x4plus_anime_6B" });
      await waitForDownload(this.downloads, job.id);
    })().finally(() => {
      this.preparingUpscaler = undefined;
    });
    return this.preparingUpscaler;
  }

  /**
   * Makes an image four times larger (Real-ESRGAN), in turn with generation.
   *
   * @param png - The image, as PNG.
   * @param signal - Abort to stop.
   * @returns The larger PNG.
   */
  async upscale(png: Buffer, signal?: AbortSignal): Promise<Buffer> {
    if (!(await this.upscaleStatus()).ready) throw new PreparingError("The upscaler is not set up yet.");
    const run = this.queue.then(async () => {
      const exe = (await this.install())!;
      const id = randomUUID();
      const input = join(tmpdir(), `kesher-up-in-${id}.png`);
      const out = join(tmpdir(), `kesher-up-out-${id}.png`);
      await writeFile(input, png);
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(exe, ["-M", "upscale", "--init-img", input, "--upscale-model", this.upscalerPath, "-o", out], { windowsHide: true, cwd: this.dir });
          let text = "";
          const onData = (b: Buffer) => (text = (text + b.toString()).slice(-4000));
          child.stdout.on("data", onData);
          child.stderr.on("data", onData);
          const kill = () => child.kill();
          signal?.addEventListener("abort", kill, { once: true });
          child.on("error", reject);
          child.on("close", (code) => {
            signal?.removeEventListener("abort", kill);
            if (code === 0) resolve();
            else reject(new Error(`The upscaler failed (exit code ${code}):\n${text.split("\n").slice(-8).join("\n")}`));
          });
        });
        return await readFile(out);
      } finally {
        await rm(input, { force: true });
        await rm(out, { force: true });
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Where the extra files of model families go. */
  private get supportDir(): string {
    return join(this.modelsDir(), "image-support");
  }

  /** @returns Image model files in `models/image`. */
  async models(): Promise<Array<{ path: string; rel: string; size: number }>> {
    const out: Array<{ path: string; rel: string; size: number }> = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (/\.(safetensors|ckpt|gguf)$/i.test(e.name) && !/mmproj|vae|clip|t5xxl|text[_-]?encoder/i.test(e.name)) {
          const size = (await stat(full)).size;
          if (size > 100 * 1024 ** 2) out.push({ path: full, rel: relative(this.imageDir, full).split(sep).join("/"), size });
        }
      }
    };
    await walk(this.imageDir);
    // Downloads from repos without a "text-to-image" tag land in models/other; pick up the ones that are clearly image models.
    const other = join(this.modelsDir(), "other");
    const before = out.length;
    await walk(other);
    for (let i = out.length - 1; i >= before; i--) {
      const m = out[i]!;
      if (!/qwen[-_ ]?image|flux|sdxl|sd[-_]?xl|stable[-_]?diffusion|sd[-_]?1\.?5|z[-_]?image/i.test(m.path)) out.splice(i, 1);
      else m.rel = `other/${relative(other, m.path).split(sep).join("/")}`;
    }
    return out;
  }

  /** Downloads the engine the first time. */
  /** Installs the engine (stable-diffusion.cpp) without a model, e.g. when Pictures is turned on. */
  installEngine(): Promise<string> {
    return this.install();
  }

  private install(): Promise<string> {
    this.installing ??= (async () => {
      const exe = process.platform === "win32" ? "sd-cli.exe" : "sd-cli";
      const existing = await findFile(this.dir, exe);
      if (existing) return existing;
      const headers = { accept: "application/vnd.github+json", "user-agent": "KesherAI" };
      const res = await fetch(`${RELEASES}/latest`, { headers });
      if (!res.ok) throw new Error(`GitHub answered ${res.status} while looking for the image engine.`);
      const release = (await res.json()) as { tag_name: string; assets: Array<{ name: string; browser_download_url: string; size: number }> };
      const picked = pickSdAssets(release.assets.map((a) => a.name), { platform: process.platform, arch: process.arch, ...(await this.gpu()) });
      if (!picked) throw new Error("stable-diffusion.cpp has no download for this computer.");
      await mkdir(this.dir, { recursive: true });
      for (const name of [picked.engine, picked.extra].filter((n): n is string => !!n)) {
        const asset = release.assets.find((a) => a.name === name)!;
        const archive = join(this.dir, name);
        const job = this.downloads.enqueue({ url: asset.browser_download_url, dest: archive, size: asset.size, label: `Image engine · ${name}` });
        await waitForDownload(this.downloads, job.id);
        await extractArchive(archive, join(this.dir, release.tag_name));
        await rm(archive, { force: true });
      }
      const found = await findFile(this.dir, exe);
      if (!found) throw new Error(`The image engine download did not contain ${exe}.`);
      return found;
    })().catch((err) => {
      this.installing = undefined;
      throw err;
    });
    return this.installing;
  }

  private companionPath(c: Companion): string {
    return join(this.supportDir, c.repo, c.path);
  }

  /**
   * Starts downloading what a model still needs (the engine and its extra
   * files). Returns at once.
   *
   * @param modelFile - The model.
   * @returns What is still missing, in GB, or 0 when it is ready.
   */
  prepare(modelFile: string): number {
    const family = familyFor(modelFile);
    const missing = family.companions.filter((c) => !existsSync(this.companionPath(c)));
    const key = family.id;
    if (!this.preparing.has(key)) {
      const p = (async () => {
        await this.install();
        for (const c of missing) {
          const files = await listHubFiles(c.repo);
          const f = files.find((x) => x.path === c.path);
          if (!f) throw new Error(`${c.repo} no longer has ${c.path}.`);
          const job = this.downloads.enqueue({
            url: f.url,
            dest: this.companionPath(c),
            size: f.size,
            ...(f.sha256 ? { sha256: f.sha256 } : {}),
            label: `${family.name} needs · ${basename(c.path)}`,
          });
          await waitForDownload(this.downloads, job.id);
        }
      })().finally(() => this.preparing.delete(key));
      p.catch(() => undefined);
      this.preparing.set(key, p);
    }
    return missing.reduce((n, c) => n + c.sizeGb, 0);
  }

  /**
   * What a model still needs before it can run: its extra files and the
   * engine itself, with sizes, for the download confirmation.
   *
   * @param modelFile - Model file name.
   * @returns The family and each extra file, with whether it is already here.
   */
  async requirements(modelFile: string): Promise<{ family: string; engineInstalled: boolean; extras: Array<{ name: string; repo: string; sizeGb: number; have: boolean }> }> {
    const family = familyFor(modelFile);
    const engineInstalled = !!(await findFile(this.dir, process.platform === "win32" ? "sd-cli.exe" : "sd-cli"));
    return {
      family: family.name,
      engineInstalled,
      extras: family.companions.map((c) => ({ name: basename(c.path), repo: c.repo, sizeGb: c.sizeGb, have: existsSync(this.companionPath(c)) })),
    };
  }

  /** @returns Whether the engine and a model's extra files are all on disk. */
  async ready(modelFile: string): Promise<boolean> {
    const exe = await findFile(this.dir, process.platform === "win32" ? "sd-cli.exe" : "sd-cli");
    return !!exe && familyFor(modelFile).companions.every((c) => existsSync(this.companionPath(c)));
  }

  /**
   * Generates a short video clip (Wan): about 2 seconds at 16 frames a
   * second by default, as WebM.
   *
   * @param modelFile - The Wan diffusion model.
   * @param req - Prompt, optional negative prompt, seconds (1–5), seed.
   * @param signal - Abort to stop.
   * @returns The video.
   */
  async generateVideo(modelFile: string, req: { prompt: string; negativePrompt?: string; seconds?: number; seed: number }, signal?: AbortSignal): Promise<GeneratedFile> {
    const v = familyFor(modelFile).video;
    if (!v) throw new Error(`${basename(modelFile)} is not a video model.`);
    if (!(await this.ready(modelFile))) {
      const gb = this.prepare(modelFile);
      throw new PreparingError(`The video engine is getting ready${gb ? `: downloading ${gb.toFixed(1)} GB of files this model needs` : ""}. Follow it in the downloads circle, then try again.`);
    }
    const frames = Math.round(Math.min(5, Math.max(1, req.seconds ?? 2)) * v.fps) + 1;
    const run = this.queue.then(() => this.runOnce(modelFile, { prompt: req.prompt, ...(req.negativePrompt ? { negativePrompt: req.negativePrompt } : {}), width: v.width, height: v.height, steps: 0, seed: req.seed, frames }, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Generates one image.
   *
   * @param modelFile - Absolute model path.
   * @param req - Prompt, size, steps, seed.
   * @param signal - Abort to stop.
   * @returns A PNG.
   * @throws PreparingError while the engine or the model's extra files download.
   */
  async generate(modelFile: string, req: Omit<ProviderImageRequest, "providerModelId">, signal?: AbortSignal): Promise<GeneratedFile> {
    if (isMlx(modelFile)) {
      throw new Error(
        `${basename(modelFile)} is in Apple's MLX format, which runs only on Mac computers. Download a GGUF version of the model instead (Models → Images shows ones that run on this computer).`,
      );
    }
    if (!(await this.ready(modelFile))) {
      const gb = this.prepare(modelFile);
      throw new PreparingError(
        `The image engine is getting ready${gb ? `: downloading ${gb.toFixed(1)} GB of files this model needs` : ""}. Follow it in the downloads circle, then try again.`,
      );
    }
    const run = this.queue.then(() =>
      this.runOnce(modelFile, req, signal, this.vulkanSafe).catch((err: Error) => {
        // The Vulkan driver reset the card mid-run (seen on Linux with an AMD RX 9060 XT, Mesa's RADV): once more
        // in a gentler way (no cooperative-matrix or integer-dot shaders, text encoder and decoder on the
        // processor), and keep that way for the next pictures.
        if (this.vulkanSafe || signal?.aborted || !DEVICE_LOST.test(err.message)) throw err;
        this.vulkanSafe = true;
        return this.runOnce(modelFile, req, signal, true).catch((again: Error) => {
          throw new Error(`${again.message}\n\nThe graphics driver reset the card while drawing (Vulkan "device lost"), also in the gentler mode. This is a driver problem, not the model: update the graphics driver (on Linux, Mesa 25.1 or newer for Radeon RX 9000 cards) and try again.`);
        });
      }),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** After a Vulkan "device lost": run in the gentler way from then on (until KesherAI restarts). */
  private vulkanSafe = false;

  private async runOnce(modelFile: string, req: Omit<ProviderImageRequest, "providerModelId"> & { frames?: number }, signal?: AbortSignal, gentle = false): Promise<GeneratedFile> {
    const exe = (await this.install())!;
    const family = familyFor(modelFile);
    const video = family.video;
    const out = join(tmpdir(), `kesher-${video ? "video" : "image"}-${randomUUID()}.${video ? "webm" : "png"}`);
    const frames = video ? Math.max(5, Math.round(((req.frames ?? video.frames) - 1) / 4) * 4 + 1) : 0;
    // Image to image, and inpainting with a mask.
    const initFile = !video && req.initImage ? join(tmpdir(), `kesher-init-${randomUUID()}.png`) : undefined;
    const maskFile = initFile && req.mask ? join(tmpdir(), `kesher-mask-${randomUUID()}.png`) : undefined;
    if (initFile) await writeFile(initFile, req.initImage!);
    if (maskFile) await writeFile(maskFile, req.mask!);
    const args = [
      ...(video ? ["-M", "vid_gen", "--video-frames", String(frames), "--fps", String(video.fps)] : []),
      family.modelFlag, modelFile,
      ...family.companions.flatMap((c) => [c.flag, this.companionPath(c)]),
      ...family.args,
      "-p", req.prompt,
      ...(req.negativePrompt ? ["-n", req.negativePrompt] : []),
      "-W", String(req.width), "-H", String(req.height),
      "--steps", String(req.steps || family.steps),
      "--cfg-scale", String(family.cfg),
      "-s", String(req.seed),
      "-o", out,
      ...(initFile ? ["-i", initFile, "--strength", String(req.strength ?? 0.75)] : []),
      ...(maskFile ? ["--mask", maskFile] : []),
      ...(/<lora:/i.test(req.prompt) && existsSync(this.loraDir) ? ["--lora-model-dir", this.loraDir] : []),
      ...(await this.memoryArgs(modelFile, family)),
      ...(gentle ? ["--clip-on-cpu", "--vae-on-cpu"] : []),
    ];
    const started = Date.now();
    this.current = { phase: "loading", startedAt: started };
    let full = `${new Date().toISOString()}\n${exe} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n\n`;
    const saveLog = () => writeFile(this.logFile, full.slice(-400_000)).catch(() => undefined);
    const log = await new Promise<string>((resolve, reject) => {
      const card = this.lastCard;
      const env = { ...process.env, ...(card !== undefined ? { CUDA_DEVICE_ORDER: "PCI_BUS_ID", CUDA_VISIBLE_DEVICES: String(card) } : {}), ...(gentle ? GENTLE_VULKAN : {}) };
      const child = spawn(exe, dedupeCpuFlags(args), { windowsHide: true, cwd: this.dir, env });
      let text = "";
      const onData = (b: Buffer) => {
        const chunk = b.toString();
        full += chunk;
        text = (text + chunk).slice(-8000);
        this.current = progressFrom(text, this.current ?? { phase: "loading", startedAt: started });
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const kill = () => child.kill();
      signal?.addEventListener("abort", kill, { once: true });
      child.on("error", (err) => {
        this.current = undefined;
        full += `\n[could not start: ${err.message}]\n`;
        void saveLog();
        reject(err);
      });
      child.on("close", (code) => {
        signal?.removeEventListener("abort", kill);
        full += `\n\n[exit code ${code}, ${Math.round((Date.now() - started) / 1000)} s]\n`;
        void saveLog();
        this.current = undefined;
        if (code === 0) resolve(text);
        else reject(new Error(`The image engine failed (exit code ${code}):\n${text.split("\n").slice(-12).join("\n")}`));
      });
    }).finally(() => {
      for (const f of [initFile, maskFile]) if (f) void rm(f, { force: true });
    });
    const data = await readFile(out).catch(() => {
      throw new Error(`The image engine finished without ${video ? "a video" : "an image"}:\n${log.split("\n").slice(-12).join("\n")}`);
    });
    await rm(out, { force: true });
    return {
      data,
      mimeType: video ? "video/webm" : "image/png",
      meta: { prompt: req.prompt, seed: req.seed, width: req.width, height: req.height, family: family.id, seconds: Math.round((Date.now() - started) / 1000), ...(video ? { frames, fps: video.fps } : {}) },
    };
  }
}

/** Real-ESRGAN's anime 6B model (the one stable-diffusion.cpp supports), from its author's GitHub release. */
const UPSCALER_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth";

/**
 * The provider that shows the built-in image engine's models under
 * "Images" and generates with them, also as the chat's `generate_image`.
 *
 * @param engine - The engine.
 * @returns A provider with id `sdcpp`.
 */
export function sdProvider(engine: SdEngine): Provider {
  const pathOf = async (id: string) => (await engine.models()).find((m) => m.rel === id)?.path;
  return {
    id: "sdcpp",
    name: "KesherAI image engine",
    location: "local",
    capabilities: { image: true },
    async checkHealth() {
      return true;
    },
    async listModels(): Promise<ModelInfo[]> {
      return (await engine.models()).filter((m) => process.platform === "darwin" || !isMlx(m.rel)).map((m) => ({
        id: `sdcpp/${m.rel}`,
        providerId: "sdcpp",
        providerModelId: m.rel,
        name: basename(m.rel).replace(/\.(safetensors|ckpt|gguf)$/i, ""),
        category: "image",
        location: "local",
        details: { family: familyFor(m.rel).name, sizeGb: Math.round((m.size / 1024 ** 3) * 10) / 10 },
      }));
    },
    async generateImage(req, signal) {
      const path = await pathOf(req.providerModelId);
      if (!path) throw new Error(`The image model ${req.providerModelId} is not in KesherAI's models folder any more.`);
      return [await engine.generate(path, req, signal)];
    },
  };
}

let pendingImageDownload: string | undefined;

/**
 * Makes sure an image model that runs here is ready, for the chat's
 * generate_image: uses a downloaded recommended model, or starts
 * downloading the one that fits this computer (Qwen-Image 2512 with 12 GB
 * of VRAM or more, otherwise FLUX.1 schnell) and makes it the active image
 * model once it is there.
 *
 * @param d - Engine, downloads, config and where models go.
 * @returns The model id to use now, or a message saying what is downloading.
 */
/** The video model KesherAI downloads when none is chosen: Wan 2.1 text-to-video 1.3B. */
export const RECOMMENDED_VIDEO_MODEL = {
  id: "wan2.1-t2v-1.3b",
  name: "Wan 2.1 text-to-video 1.3B",
  repo: "Comfy-Org/Wan_2.1_ComfyUI_repackaged",
  file: "split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors",
};
let pendingVideoDownload: string | undefined;

/** The files ComfyUI's Wan 2.1 workflow needs, in KesherAI's models folder (ComfyUI reads it too). */
function comfyWanFiles(modelsDir: string) {
  const repo = RECOMMENDED_VIDEO_MODEL.repo;
  return [
    { repo, path: RECOMMENDED_VIDEO_MODEL.file, dest: join(modelsDir, "video", repo, RECOMMENDED_VIDEO_MODEL.file), label: "Wan 2.1 1.3B" },
    { repo, path: "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", dest: join(modelsDir, "text_encoders", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"), label: "Wan text encoder (umt5 xxl)" },
    { repo, path: "split_files/vae/wan_2.1_vae.safetensors", dest: join(modelsDir, "vae", "wan_2.1_vae.safetensors"), label: "Wan VAE" },
  ];
}

/**
 * @param modelsDir - KesherAI's models folder.
 * @returns Whether ComfyUI has everything for Wan video, and how much is missing (GB, approximate).
 */
export function comfyWanStatus(modelsDir: string): { ready: boolean; missingGb: number } {
  const sizes: Record<string, number> = { "Wan 2.1 1.3B": 2.84, "Wan text encoder (umt5 xxl)": 6.74, "Wan VAE": 0.25 };
  const missing = comfyWanFiles(modelsDir).filter((f) => !existsSync(f.dest));
  return { ready: !missing.length, missingGb: missing.reduce((n, f) => n + (sizes[f.label] ?? 0), 0) };
}

/**
 * Downloads what ComfyUI needs to make videos with Wan 2.1 (the model is
 * shared with the built-in engine). Follow it in the downloads circle.
 *
 * @param d - Downloads and the models folder.
 * @returns How many files started downloading.
 */
export async function setupComfyWan(d: { downloads: DownloadManager; modelsDir: () => string }): Promise<number> {
  let n = 0;
  for (const f of comfyWanFiles(d.modelsDir())) {
    if (existsSync(f.dest) || d.downloads.list().some((j) => j.dest === f.dest && !["failed", "cancelled", "done"].includes(j.status))) continue;
    const hub = (await listHubFiles(f.repo)).find((x) => x.path === f.path);
    if (!hub) throw new Error(`${f.repo} no longer has ${f.path}.`);
    d.downloads.enqueue({ url: hub.url, dest: f.dest, size: hub.size, ...(hub.sha256 ? { sha256: hub.sha256 } : {}), label: `ComfyUI video · ${f.label}` });
    n++;
  }
  return n;
}

/**
 * The video model's state, without starting anything.
 *
 * @param d - The engine, settings and models folder.
 * @returns Whether a video model is ready, downloading, or not there yet.
 */
export async function videoStatus(d: { sd: SdEngine; config: { activeModels: Record<string, string> }; modelsDir: () => string }): Promise<{ ready: boolean; downloading: boolean; model?: string }> {
  const chosen = d.config.activeModels.video;
  const dest = join(d.modelsDir(), "video", RECOMMENDED_VIDEO_MODEL.repo, RECOMMENDED_VIDEO_MODEL.file);
  const file = chosen && existsSync(chosen) ? chosen : existsSync(dest) ? dest : undefined;
  const ready = !!file && (await d.sd.ready(file).catch(() => false));
  return { ready, downloading: !!pendingVideoDownload || (!!file && !ready), ...(file ? { model: basename(file) } : {}) };
}

/**
 * Finds the video model, or starts downloading one (with its encoder and
 * VAE) the way {@link ensureImageModel} does for pictures.
 *
 * @param d - Engine, downloads, config and models folder.
 * @returns The model's path, or a message to tell the user.
 */
export async function ensureVideoModel(d: { sd: SdEngine; downloads: DownloadManager; config: { activeModels: Record<string, string> }; modelsDir: () => string; save: () => Promise<void> }): Promise<{ path?: string; message?: string }> {
  const m = RECOMMENDED_VIDEO_MODEL;
  const dest = join(d.modelsDir(), "video", m.repo, m.file);
  const chosen = d.config.activeModels.video;
  if (chosen && existsSync(chosen)) return { path: chosen };
  if (existsSync(dest)) {
    if (!(await d.sd.ready(dest))) {
      const gb = d.sd.prepare(dest);
      return { message: `The video model's extra files are downloading (about ${gb.toFixed(1)} GB). Tell the user to follow them in the downloads circle and ask again when they are done.` };
    }
    d.config.activeModels.video = dest;
    await d.save();
    return { path: dest };
  }
  if (pendingVideoDownload) return { message: `${m.name} is still downloading. Tell the user to follow it in the downloads circle and ask again when it is done.` };
  const files = await listHubFiles(m.repo);
  const f = files.find((x) => x.path === m.file);
  if (!f) return { message: `Could not find ${m.file} on Hugging Face.` };
  pendingVideoDownload = m.id;
  const job = d.downloads.enqueue({ url: f.url, dest, size: f.size, ...(f.sha256 ? { sha256: f.sha256 } : {}), label: `${m.name} · ${basename(m.file)}` });
  const extraGb = d.sd.prepare(dest);
  void waitForDownload(d.downloads, job.id)
    .then(async () => {
      d.config.activeModels.video = dest;
      await d.save();
    })
    .catch(() => undefined)
    .finally(() => {
      pendingVideoDownload = undefined;
    });
  return { message: `There was no video model yet, so KesherAI started downloading ${m.name} (about ${(f.size / 1024 ** 3 + extraGb).toFixed(1)} GB with its text encoder and VAE). Tell the user it is downloading (they can follow it in the downloads circle) and to ask again when it is done.` };
}

/**
 * Finds an image model that runs on this computer, or starts downloading one
 * that fits (Qwen-Image with 12 GB of graphics memory or more, else Flux).
 *
 * @param d - Engine, downloads, config and models folder.
 * @returns The model id, or a message to tell the user.
 */
export async function ensureImageModel(d: {
  sd: SdEngine;
  downloads: DownloadManager;
  config: { activeModels: Record<string, string> };
  modelsDir: () => string;
  save: () => Promise<void>;
}): Promise<{ modelId?: string; message?: string }> {
  const idOf = (m: (typeof RECOMMENDED_IMAGE_MODELS)[number]) => `sdcpp/${m.repo}/${m.file}`;
  for (const m of RECOMMENDED_IMAGE_MODELS) {
    if (existsSync(join(d.modelsDir(), "image", m.repo, m.file))) {
      d.config.activeModels.image = idOf(m);
      await d.save();
      return { modelId: idOf(m) };
    }
  }
  const { detectHardwareCached } = await import("@kesher/downloads");
  const hw = await detectHardwareCached();
  const vramGb = Math.max(0, ...hw.gpus.map((g) => g.vramTotal / 1024 ** 3));
  const pick = RECOMMENDED_IMAGE_MODELS.find((m) => m.id === (vramGb >= 12 ? "qwen-image-2512" : "flux-schnell"))!;
  if (pendingImageDownload === pick.id) {
    return { message: `${pick.name} is still downloading for images. Follow it in the downloads circle; ask again when it is done.` };
  }
  const files = await listHubFiles(pick.repo);
  const f = files.find((x) => x.path === pick.file);
  if (!f) return { message: `Could not find ${pick.file} on Hugging Face. Pick an image model under Models → Images.` };
  pendingImageDownload = pick.id;
  const job = d.downloads.enqueue({
    url: f.url,
    dest: join(d.modelsDir(), "image", pick.repo, pick.file),
    size: f.size,
    ...(f.sha256 ? { sha256: f.sha256 } : {}),
    label: `${pick.name} · ${pick.file}`,
  });
  const extraGb = d.sd.prepare(pick.file);
  void waitForDownload(d.downloads, job.id)
    .then(async () => {
      d.config.activeModels.image = idOf(pick);
      await d.save();
    })
    .catch(() => undefined)
    .finally(() => {
      pendingImageDownload = undefined;
    });
  const gb = f.size / 1024 ** 3 + extraGb;
  return {
    message: `There was no image model that runs on this computer, so KesherAI started downloading ${pick.name} (about ${gb.toFixed(1)} GB with the files it needs). Tell the user it is downloading (they can follow it in the downloads circle) and to ask again when it is done; it becomes their image model by itself.`,
  };
}
