/**
 * The engines built from the config alone (docs/ARCHITECTURE_REVIEW.md B3, first part): which NVIDIA cards there are,
 * the llama.cpp chat engine and the image engine (stable-diffusion.cpp). ComfyUI and the card guard need other
 * services and are still made in server.ts.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { detectHardwareCached, type DownloadManager } from "@kesher/downloads";
import type { ProviderRegistry } from "@kesher/providers";
import { loadSettingsArgs } from "@kesher/shared";
import { ComfyManager } from "../comfy-manager.js";
import type { DataPaths, KesherConfig } from "../config.js";
import type { Runtimes } from "../runtimes.js";
import { bySpeed, planGpus, type Gpu } from "../gpus.js";
import { LlamaEngine } from "../llamacpp.js";
import type { ModelUse } from "../pc-fix.js";
import { SdEngine } from "../sdcpp.js";

/** @returns NVIDIA cards with their PCI-order index. */
export async function nvidiaGpus(): Promise<Gpu[]> {
  return (await detectHardwareCached()).gpus
    .filter((g) => /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(g.name))
    .map((g, i) => ({ index: g.index ?? i, name: g.name, vramTotal: g.vramTotal, vramFree: g.vramFree, ...(g.computeCap ? { computeCap: g.computeCap } : {}) }));
}

/**
 * The built-in chat engine (llama.cpp), set up from the config; the cards it uses are planned at each load.
 *
 * @param paths - The data folders.
 * @param config - The settings (read now, and the card choice at each load).
 * @param modelUse - Records when each model was loaded (PC Health).
 * @returns The engine (nothing loaded yet).
 */
export function buildLlamaEngine(paths: DataPaths, config: KesherConfig, modelUse: ModelUse): LlamaEngine {
  return new LlamaEngine({
    dir: paths.engines,
    ...(config.engines.llamaServerPath ? { binaryPath: config.engines.llamaServerPath } : {}),
    ...(config.engines.llamaVersion ? { version: config.engines.llamaVersion } : {}),
    port: config.engines.llamaServerPort,
    args: config.engines.llamaServerArgs,
    parallel: config.engines.parallel,
    ...(config.engines.mtpDraft !== undefined ? { mtpDraft: config.engines.mtpDraft } : {}),
    ...(config.engines.lookup !== undefined ? { lookup: config.engines.lookup } : {}),
    ...(config.engines.ramCache !== undefined ? { ramCache: config.engines.ramCache } : {}),
    ...(config.engines.fitTargetMiB !== undefined ? { fitTargetMiB: config.engines.fitTargetMiB } : {}),
    ...(config.engines.kvType !== undefined ? { kvType: config.engines.kvType } : {}),
    // A model's own load settings (Models → ⚙), read at each load so a change needs no restart.
    modelArgs: (modelPath) => loadSettingsArgs(config.engines.modelSettings[basename(modelPath)]),
    gpuPlan: async (modelPath) => planGpus(await nvidiaGpus(), config.engines.gpus, await modelSize(modelPath)),
    onLoad: (modelPath) => void modelUse.used(modelPath),
  });
}

/**
 * The built-in image engine (stable-diffusion.cpp). It uses one card: the fastest allowed one, or the chosen leader.
 *
 * @param paths - The data folders (models are read where they are at each use).
 * @param downloads - For its own download.
 * @param config - The card settings.
 * @returns The engine.
 */
export function buildSdEngine(paths: DataPaths, downloads: DownloadManager, config: KesherConfig): SdEngine {
  return new SdEngine(join(paths.engines, "sdcpp"), () => paths.models, downloads, async () => {
    const nv = await nvidiaGpus();
    const pool = nv.filter((g) => !config.engines.gpus.use || config.engines.gpus.use.includes(g.index));
    const card = pool.find((g) => g.index === config.engines.gpus.main) ?? bySpeed(pool)[0];
    return { nvidia: nv.length > 0, ...(card ? { vramGb: card.vramFree / 1024 ** 3, cudaIndex: card.index } : {}) };
  });
}

/**
 * @param modelPath - A GGUF file (the first part of a split model).
 * @returns Its size in bytes, adding the other parts of a split model.
 */
async function modelSize(modelPath: string): Promise<number> {
  const split = /^(.*)-00001-of-(\d{5})\.gguf$/i.exec(basename(modelPath));
  if (!split) return (await stat(modelPath).catch(() => ({ size: 0 }))).size;
  const files = (await readdir(dirname(modelPath)).catch(() => [])).filter((f) => f.startsWith(`${split[1]}-`) && f.endsWith(`-of-${split[2]}.gguf`));
  const sizes = await Promise.all(files.map((f) => stat(join(dirname(modelPath), f)).then((x) => x.size, () => 0)));
  return sizes.reduce((a, b) => a + b, 0);
}

/**
 * An AMD graphics card with at least 4 GB of its own memory, on Linux (its driver's files in /sys).
 *
 * @param root - The sysfs folder (tests pass their own).
 */
export async function amdCardOnLinux(root = "/sys/class/drm"): Promise<boolean> {
  if (process.platform !== "linux") return false;
  for (const c of await readdir(root).catch(() => [] as string[])) {
    if (!/^card\d+$/.test(c)) continue;
    const vendor = (await readFile(`${root}/${c}/device/vendor`, "utf8").catch(() => "")).trim();
    const vram = Number((await readFile(`${root}/${c}/device/mem_info_vram_total`, "utf8").catch(() => "0")).trim());
    if (vendor === "0x1002" && vram >= 4 * 1024 ** 3) return true;
  }
  return false;
}

/**
 * ComfyUI, KesherAI's image and node engine (not started here): installed into the engines folder, on the NVIDIA
 * card, ROCm (Linux with an AMD card) or the processor; once it runs, its checkpoints become image models.
 *
 * @param p - The data folders, downloads, Python runtimes, the settings and the models.
 * @returns ComfyUI's manager.
 */
export function buildComfy(p: { paths: DataPaths; downloads: DownloadManager; runtimes: Runtimes; config: KesherConfig; registry: ProviderRegistry }): ComfyManager {
  const { paths, downloads, runtimes, config, registry } = p;
  return new ComfyManager(join(paths.engines, "comfyui"), {
    downloads,
    runtimes,
    modelsDir: () => paths.models,
    port: () => config.comfyui.port,
    folder: () => config.comfyui.folder,
    gpu: () => config.comfyui.gpu,
    nvidia: async () => (await nvidiaGpus()).length > 0,
    // Linux with an AMD card (RDNA 2 or newer has enough memory to matter): ComfyUI on ROCm.
    amd: async () => amdCardOnLinux(),
    onReady: (url) => {
      // ComfyUI's checkpoints become image models.
      if (!registry.get("comfyui")) registry.add({ id: "comfyui", type: "comfyui", name: "ComfyUI (KesherAI)", location: "local", baseUrl: url });
    },
  });
}
