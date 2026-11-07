import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
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
}

/**
 * Model families. Companion repositories are the ones the
 * stable-diffusion.cpp and Unsloth guides use.
 */
export const FAMILIES: ModelFamily[] = [
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

async function findFile(dir: string, name: string): Promise<string | undefined> {
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

/** Thrown when the engine or a model's extra files are still downloading. */
export class PreparingError extends Error {}

/** Runs stable-diffusion.cpp and owns its files. */
export class SdEngine {
  private installing?: Promise<string>;
  private preparing = new Map<string, Promise<void>>();
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * @param dir - Engine folder (inside KesherAI's engines folder).
   * @param modelsDir - Returns KesherAI's models folder.
   * @param downloads - The download queue.
   * @param gpu - Whether this computer has an NVIDIA GPU (picks the CUDA build).
   */
  constructor(
    private readonly dir: string,
    private readonly modelsDir: () => string,
    private readonly downloads: DownloadManager,
    private readonly gpu: () => Promise<{ nvidia: boolean }>,
  ) {}

  private get imageDir(): string {
    return join(this.modelsDir(), "image");
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
   * Generates one image.
   *
   * @param modelFile - Absolute model path.
   * @param req - Prompt, size, steps, seed.
   * @param signal - Abort to stop.
   * @returns A PNG.
   * @throws PreparingError while the engine or the model's extra files download.
   */
  async generate(modelFile: string, req: Omit<ProviderImageRequest, "providerModelId">, signal?: AbortSignal): Promise<GeneratedFile> {
    if (!(await this.ready(modelFile))) {
      const gb = this.prepare(modelFile);
      throw new PreparingError(
        `The image engine is getting ready${gb ? `: downloading ${gb.toFixed(1)} GB of files this model needs` : ""}. Follow it in the downloads circle, then try again.`,
      );
    }
    const run = this.queue.then(() => this.runOnce(modelFile, req, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runOnce(modelFile: string, req: Omit<ProviderImageRequest, "providerModelId">, signal?: AbortSignal): Promise<GeneratedFile> {
    const exe = (await this.install())!;
    const family = familyFor(modelFile);
    const out = join(tmpdir(), `kesher-image-${randomUUID()}.png`);
    const args = [
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
    ];
    const started = Date.now();
    const log = await new Promise<string>((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true, cwd: this.dir });
      let text = "";
      const onData = (b: Buffer) => {
        text = (text + b.toString()).slice(-8000);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const kill = () => child.kill();
      signal?.addEventListener("abort", kill, { once: true });
      child.on("error", reject);
      child.on("close", (code) => {
        signal?.removeEventListener("abort", kill);
        if (code === 0) resolve(text);
        else reject(new Error(`The image engine failed (exit code ${code}):\n${text.split("\n").slice(-12).join("\n")}`));
      });
    });
    const data = await readFile(out).catch(() => {
      throw new Error(`The image engine finished without an image:\n${log.split("\n").slice(-12).join("\n")}`);
    });
    await rm(out, { force: true });
    return {
      data,
      mimeType: "image/png",
      meta: { prompt: req.prompt, seed: req.seed, width: req.width, height: req.height, family: family.id, seconds: Math.round((Date.now() - started) / 1000) },
    };
  }
}

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
      return (await engine.models()).map((m) => ({
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
