import { existsSync } from "node:fs";
import { join } from "node:path";
import { listHubFiles, type DownloadManager } from "@kesher/downloads";

/**
 * Ready-made ComfyUI flows the Nodes page loads with one tap: music with
 * ACE-Step and 3D objects with Hunyuan3D 2 — both built into ComfyUI, no
 * custom nodes. Each flow lists the model files it needs; they download
 * into KesherAI's models folder, which ComfyUI reads too (`music/`, `3d/`).
 *
 * The flows follow ComfyUI's own examples (github.com/Comfy-Org/example_workflows),
 * in ComfyUI's API format. A checkpoint name is filled in when the flow
 * loads, from what ComfyUI lists, because ComfyUI writes sub-folders with
 * the computer's own separator ("music\\…" on Windows).
 */

/** A model file a flow needs. */
export interface FlowFile {
  label: string;
  /** Hugging Face repo and file (size and checksum come from the Hub). */
  repo: string;
  path: string;
  /** Path inside the models folder, with "/". */
  rel: string;
  /** Approximate size, GB. */
  gb: number;
}

/** A node in ComfyUI's API format. */
export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title: string };
}

/** One ready-made flow. */
export interface ReadyFlow {
  id: string;
  icon: string;
  title: { en: string; he: string };
  description: { en: string; he: string };
  /** The model's licence, shown before downloading. */
  license: { name: string; url: string };
  files: FlowFile[];
  /** Node ids whose `ckpt_name` is set to the file with this name. */
  checkpoints: Record<string, string>;
  flow: Record<string, ApiNode>;
}

const seed = () => Math.floor(Math.random() * 2 ** 48);

/** The flows. */
export function readyFlows(): ReadyFlow[] {
  return [
    {
      id: "music-ace-step",
      icon: "🎵",
      title: { en: "Music from words (ACE-Step)", he: "מוזיקה ממילים (ACE-Step)" },
      description: {
        en: "Write the style (tags) and the lyrics; ACE-Step makes a song up to 4 minutes long. Lyrics in English letters work best ([verse], [chorus]…).",
        he: "כותבים סגנון (תגיות) ומילים, ו-ACE-Step יוצר שיר של עד 4 דקות. מילים באותיות אנגליות עובדות הכי טוב ([verse], [chorus]…).",
      },
      license: { name: "Apache-2.0", url: "https://github.com/ace-step/ACE-Step/blob/main/LICENSE" },
      files: [
        {
          label: "ACE-Step v1 3.5B",
          repo: "Comfy-Org/ACE-Step_ComfyUI_repackaged",
          path: "all_in_one/ace_step_v1_3.5b.safetensors",
          rel: "music/ace_step_v1_3.5b.safetensors",
          gb: 7.7,
        },
      ],
      checkpoints: { "1": "ace_step_v1_3.5b.safetensors" },
      flow: {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "ace_step_v1_3.5b.safetensors" }, _meta: { title: "ACE-Step" } },
        "2": {
          class_type: "TextEncodeAceStepAudio",
          inputs: {
            clip: ["1", 1],
            tags: "pop, upbeat, female vocals, piano, guitar, drums, catchy, bright",
            lyrics: "[verse]\nMorning light on the window\nCoffee warm in my hands\nEvery road that I follow\nLeads me back where I stand\n\n[chorus]\nSing it loud, sing it free\nThis is where I want to be\n",
            lyrics_strength: 0.99,
          },
          _meta: { title: "Style and lyrics" },
        },
        "3": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["2", 0] } },
        "4": { class_type: "EmptyAceStepLatentAudio", inputs: { seconds: 60, batch_size: 1 }, _meta: { title: "Length (seconds)" } },
        "5": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 5 } },
        "6": { class_type: "LatentOperationTonemapReinhard", inputs: { multiplier: 1 }, _meta: { title: "Vocals (higher = louder)" } },
        "7": { class_type: "LatentApplyOperationCFG", inputs: { model: ["5", 0], operation: ["6", 0] } },
        "8": { class_type: "KSampler", inputs: { model: ["7", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], seed: seed(), steps: 50, cfg: 5, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
        "9": { class_type: "VAEDecodeAudio", inputs: { samples: ["8", 0], vae: ["1", 2] } },
        "10": { class_type: "SaveAudioMP3", inputs: { audio: ["9", 0], filename_prefix: "audio/KesherAI", quality: "V0" } },
      },
    },
    {
      id: "3d-hunyuan3d",
      icon: "🧊",
      title: { en: "3D object from a picture (Hunyuan3D 2)", he: "אובייקט תלת-ממד מתמונה (Hunyuan3D 2)" },
      description: {
        en: "Load a picture of one object on a plain background; Hunyuan3D 2 makes a 3D model (GLB, without colors) you can open in Blender, Unreal or Unity.",
        he: "טוענים תמונה של אובייקט אחד על רקע חלק, ו-Hunyuan3D 2 יוצר מודל תלת-ממד (GLB, בלי צבעים) שאפשר לפתוח ב-Blender, Unreal או Unity.",
      },
      license: { name: "Tencent Hunyuan 3D 2.0 Community License (not for use in the EU, UK or South Korea)", url: "https://huggingface.co/tencent/Hunyuan3D-2/blob/main/LICENSE" },
      files: [
        {
          label: "Hunyuan3D 2 (shape)",
          repo: "tencent/Hunyuan3D-2",
          path: "hunyuan3d-dit-v2-0/model.fp16.safetensors",
          rel: "3d/hunyuan3d-dit-v2.safetensors",
          gb: 4.9,
        },
      ],
      checkpoints: { "1": "hunyuan3d-dit-v2.safetensors" },
      flow: {
        "1": { class_type: "ImageOnlyCheckpointLoader", inputs: { ckpt_name: "hunyuan3d-dit-v2.safetensors" }, _meta: { title: "Hunyuan3D 2" } },
        "2": { class_type: "LoadImage", inputs: { image: "example.png" }, _meta: { title: "Picture of the object" } },
        "3": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["1", 1], image: ["2", 0], crop: "none" } },
        "4": { class_type: "Hunyuan3Dv2Conditioning", inputs: { clip_vision_output: ["3", 0] } },
        "5": { class_type: "EmptyLatentHunyuan3Dv2", inputs: { resolution: 3072, batch_size: 1 } },
        "6": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 1 } },
        "7": { class_type: "KSampler", inputs: { model: ["6", 0], positive: ["4", 0], negative: ["4", 1], latent_image: ["5", 0], seed: seed(), steps: 20, cfg: 1, sampler_name: "euler", scheduler: "normal", denoise: 1 } },
        "8": { class_type: "VAEDecodeHunyuan3D", inputs: { samples: ["7", 0], vae: ["1", 2], num_chunks: 8000, octree_resolution: 256 } },
        "9": { class_type: "VoxelToMeshBasic", inputs: { voxel: ["8", 0], threshold: 0.6 } },
        "10": { class_type: "SaveGLB", inputs: { mesh: ["9", 0], filename_prefix: "mesh/KesherAI" } },
      },
    },
    {
      id: "styled-frame",
      icon: "🎞️",
      title: { en: "A styled game frame (keeps the scene's shapes)", he: "פריים מעוצב מהמשחק (שומר על הצורות של הסצנה)" },
      description: {
        en: "Load a screenshot of your game (Unity's Game view or Unreal's viewport) and describe the look (\"watercolor, warm sunset\", \"anime cel shading\"). The edges of the scene guide a ControlNet, so the layout stays and only the style changes. Use it for concept art, key art or a look test before you build it in the engine.",
        he: "טוענים צילום מסך מהמשחק (Game view ב-Unity או ה-viewport ב-Unreal) ומתארים את המראה (\"צבעי מים, שקיעה חמה\", \"אנימה cel shading\"). הקווים של הסצנה מנחים ControlNet, כך שהקומפוזיציה נשמרת ורק הסגנון משתנה. טוב לקונספט, לתמונת שער או לבדיקת מראה לפני שבונים אותו במנוע.",
      },
      license: { name: "CreativeML Open RAIL-M (Stable Diffusion 1.5); ControlNet 1.1: OpenRAIL", url: "https://huggingface.co/spaces/CompVis/stable-diffusion-license" },
      files: [
        { label: "Stable Diffusion 1.5 (fp16)", repo: "Comfy-Org/stable-diffusion-v1-5-archive", path: "v1-5-pruned-emaonly-fp16.safetensors", rel: "image/v1-5-pruned-emaonly-fp16.safetensors", gb: 2.1 },
        { label: "ControlNet 1.1 canny (fp16)", repo: "comfyanonymous/ControlNet-v1-1_fp16_safetensors", path: "control_v11p_sd15_canny_fp16.safetensors", rel: "controlnet/control_v11p_sd15_canny_fp16.safetensors", gb: 0.7 },
      ],
      checkpoints: { "1": "v1-5-pruned-emaonly-fp16.safetensors" },
      flow: {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "v1-5-pruned-emaonly-fp16.safetensors" }, _meta: { title: "Stable Diffusion 1.5" } },
        "2": { class_type: "LoadImage", inputs: { image: "example.png" }, _meta: { title: "Screenshot of the game" } },
        "3": { class_type: "ImageScale", inputs: { image: ["2", 0], upscale_method: "lanczos", width: 768, height: 432, crop: "center" }, _meta: { title: "Size (16:9)" } },
        "4": { class_type: "Canny", inputs: { image: ["3", 0], low_threshold: 0.3, high_threshold: 0.6 }, _meta: { title: "The scene's edges" } },
        "5": { class_type: "ControlNetLoader", inputs: { control_net_name: "control_v11p_sd15_canny_fp16.safetensors" } },
        "6": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "watercolor painting of a game scene, soft warm sunset light, painterly, detailed" }, _meta: { title: "The look you want" } },
        "7": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "blurry, low quality, text, watermark, distorted" }, _meta: { title: "What to avoid" } },
        "8": { class_type: "ControlNetApplyAdvanced", inputs: { positive: ["6", 0], negative: ["7", 0], control_net: ["5", 0], image: ["4", 0], strength: 0.9, start_percent: 0, end_percent: 1, vae: ["1", 2] }, _meta: { title: "Keep the shapes (strength)" } },
        "9": { class_type: "VAEEncode", inputs: { pixels: ["3", 0], vae: ["1", 2] } },
        "10": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["8", 0], negative: ["8", 1], latent_image: ["9", 0], seed: seed(), steps: 25, cfg: 7, sampler_name: "dpmpp_2m", scheduler: "karras", denoise: 0.75 }, _meta: { title: "How much to change (denoise)" } },
        "11": { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["1", 2] } },
        "12": { class_type: "SaveImage", inputs: { images: ["11", 0], filename_prefix: "styled/KesherAI" } },
      },
    },
  ];
}

/**
 * @param flow - A ready-made flow.
 * @param modelsDir - KesherAI's models folder.
 * @param downloads - To see what is downloading.
 * @returns Whether its files are there, downloading, and how much is missing.
 */
export function flowState(flow: ReadyFlow, modelsDir: string, downloads: DownloadManager): { ready: boolean; downloading: boolean; missingGb: number } {
  const missing = flow.files.filter((f) => !existsSync(join(modelsDir, ...f.rel.split("/"))));
  const downloading = missing.some((f) => downloads.list().some((j) => j.dest === join(modelsDir, ...f.rel.split("/")) && !["failed", "cancelled", "done"].includes(j.status)));
  return { ready: !missing.length, downloading, missingGb: Math.round(missing.reduce((n, f) => n + f.gb, 0) * 10) / 10 };
}

/**
 * Starts downloading a flow's missing files (follow them in the downloads circle).
 *
 * @param flow - The flow.
 * @param modelsDir - KesherAI's models folder.
 * @param downloads - The download manager.
 * @returns How many downloads started.
 * @throws Error when the Hub no longer has a file.
 */
export async function setupFlow(flow: ReadyFlow, modelsDir: string, downloads: DownloadManager): Promise<number> {
  let n = 0;
  for (const f of flow.files) {
    const dest = join(modelsDir, ...f.rel.split("/"));
    if (existsSync(dest) || downloads.list().some((j) => j.dest === dest && !["failed", "cancelled", "done"].includes(j.status))) continue;
    const hub = (await listHubFiles(f.repo)).find((x) => x.path === f.path);
    if (!hub) throw new Error(`${f.repo} no longer has ${f.path}.`);
    downloads.enqueue({ url: hub.url, dest, size: hub.size, ...(hub.sha256 ? { sha256: hub.sha256 } : {}), label: `${flow.icon} ${f.label}` });
    n++;
  }
  return n;
}

/**
 * Puts the real checkpoint names (as ComfyUI lists them) into a flow.
 *
 * @param flow - The flow.
 * @param available - Checkpoint names ComfyUI offers, e.g. `music\\ace_step_v1_3.5b.safetensors`.
 * @returns A copy with `ckpt_name` filled in; names not found stay as they were.
 */
export function withCheckpoints(flow: ReadyFlow, available: readonly string[]): Record<string, ApiNode> {
  const out = structuredClone(flow.flow);
  for (const [id, file] of Object.entries(flow.checkpoints)) {
    const found = available.find((a) => a.split(/[\\/]/).pop() === file);
    if (found && out[id]) out[id].inputs.ckpt_name = found;
  }
  return out;
}
