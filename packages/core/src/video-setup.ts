/**
 * Video's setup: the Wan 2.1 model KesherAI downloads when none is chosen, the files ComfyUI's Wan workflow needs,
 * and whether a video model is ready (sdcpp.ts re-exports these).
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { listHubFiles, type DownloadManager } from "@kesher/downloads";
import { waitForDownload } from "./llamacpp.js";
import type { SdEngine } from "./sdcpp.js";

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
