import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Training models from KesherAI, step 1: a picture LoRA (a style, a
 * character or an object) from 10–30 of the user's own pictures, trained by
 * ComfyUI's built-in training nodes (TrainLoraNode, same licence as ComfyUI,
 * GPL-3.0 — run as a separate program, not linked) on an SD 1.5 or SDXL
 * checkpoint. The result goes where the picture engine finds LoRAs, so it
 * shows on the Images page at once.
 *
 * What each kind needs is said up front (graphics memory, ComfyUI, a base
 * model), so the page can tell the user what this computer can train.
 */

/** A kind of training, and whether this computer can do it. */
export interface TrainingKind {
  id: "image-lora" | "chat-lora" | "voice";
  ready: boolean;
  /** Why not, or what to know (plain words). */
  notes: string[];
  /** For pictures: the base models found. */
  bases?: Array<{ name: string; family: "sd15" | "sdxl" | "other" }>;
  /** Roughly how long, at the default settings. */
  estimate?: string;
}

/** One training job. */
export interface TrainingJob {
  id: string;
  kind: "image-lora";
  name: string;
  base: string;
  status: "running" | "done" | "error";
  startedAt: string;
  finishedAt?: string;
  message?: string;
  /** The LoRA file, in the picture engine's LoRA folder. */
  file?: string;
  steps: number;
}

/** What training needs from the rest of KesherAI. */
export interface TrainingDeps {
  comfy: () => { installed: boolean; running: boolean; folder?: string; url: string };
  /** Graphics memory of the biggest NVIDIA card, in GB (0 when there is none). */
  vramGb: () => Promise<number>;
  /** ComfyUI's node list (GET /object_info). */
  objectInfo: () => Promise<Record<string, { input?: { required?: Record<string, unknown[]> } }>>;
  /** Runs a flow in ComfyUI (API format) and waits. */
  runFlow: (flow: Record<string, { class_type: string; inputs: Record<string, unknown> }>, signal: AbortSignal) => Promise<unknown>;
  /** Where the picture engine reads LoRAs. */
  loraDir: () => string;
  /** Stops what ComfyUI is running. */
  interrupt?: () => Promise<void>;
}

/**
 * Fills the inputs a node needs that the flow did not set, from ComfyUI's
 * own node list (its default, or a list's first choice), so the flow works
 * with the ComfyUI version the user has.
 */
export function fillDefaults(flow: Record<string, { class_type: string; inputs: Record<string, unknown> }>, info: Record<string, { input?: { required?: Record<string, unknown[]> } }>): void {
  for (const node of Object.values(flow)) {
    for (const [key, spec] of Object.entries(info[node.class_type]?.input?.required ?? {})) {
      if (key in node.inputs || !Array.isArray(spec)) continue;
      const [type, opts] = spec as [unknown, { default?: unknown } | undefined];
      if (opts && typeof opts === "object" && "default" in opts) node.inputs[key] = opts.default;
      else if (opts && typeof opts === "object" && Array.isArray((opts as { options?: unknown[] }).options) && (opts as { options: unknown[] }).options.length) node.inputs[key] = (opts as { options: unknown[] }).options[0];
      else if (Array.isArray(type) && type.length) node.inputs[key] = type[0];
    }
  }
}

/** Node names change between ComfyUI versions; the first one that exists is used. */
const DATASET = ["LoadImageDataSetFromFolder", "LoadImageSetFromFolderNode"];
const SAVE = ["SaveLoRA", "SaveLoRANode"];

const family = (name: string): "sd15" | "sdxl" | "other" => (/xl|pony|illustrious|noob/i.test(name) ? "sdxl" : /1[._-]?5|sd15|v1-5|realistic|dreamshaper(?!.*xl)/i.test(name) ? "sd15" : "other");

/** A safe folder and file name from what the user typed. */
export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "lora";

/** Trains, one job at a time. */
export class Training {
  private jobs: TrainingJob[] = [];
  private abort?: AbortController;

  /** @param deps - ComfyUI, the graphics card and the LoRA folder. */
  constructor(private readonly deps: TrainingDeps) {}

  /** @returns What this computer can train, and why not. */
  async kinds(): Promise<TrainingKind[]> {
    const comfy = this.deps.comfy();
    const vram = await this.deps.vramGb().catch(() => 0);
    const picture: TrainingKind = { id: "image-lora", ready: false, notes: [] };
    if (!vram) picture.notes.push("Needs an NVIDIA graphics card (8 GB or more for SD 1.5, 12 GB or more for SDXL).");
    else if (vram < 8) picture.notes.push(`This card has ${vram.toFixed(0)} GB; training needs 8 GB or more.`);
    if (!comfy.installed) picture.notes.push("Needs ComfyUI: install it once on the Nodes page.");
    else if (!comfy.running) picture.notes.push("Start ComfyUI first (the Nodes page).");
    if (comfy.running) {
      try {
        const info = await this.deps.objectInfo();
        if (!info.TrainLoraNode || !DATASET.some((n) => info[n]) || !SAVE.some((n) => info[n])) picture.notes.push("This ComfyUI is too old for training: update it (Nodes page → Update).");
        const ckpts = (info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] as string[] | undefined) ?? [];
        picture.bases = ckpts.map((name) => ({ name, family: family(name) }));
        if (!ckpts.length) picture.notes.push("Needs a base model (an SD 1.5 or SDXL checkpoint) in ComfyUI's models/checkpoints folder.");
      } catch {
        picture.notes.push("ComfyUI did not answer.");
      }
    }
    picture.ready = picture.notes.length === 0;
    if (vram) picture.estimate = vram >= 16 ? "About 15–30 minutes (SDXL, 600 steps)." : "About 30–60 minutes (SD 1.5 is quicker than SDXL).";
    return [
      picture,
      { id: "chat-lora", ready: false, notes: ["Coming next: teach a chat model your writing or your notes (LoRA on your texts)."] },
      { id: "voice", ready: false, notes: ["Later: a voice of your own from a few minutes of speech."] },
    ];
  }

  /** @returns The jobs, newest first. */
  list(): TrainingJob[] {
    return [...this.jobs].reverse();
  }

  /**
   * Starts training a picture LoRA.
   *
   * @param req - What to train.
   * @param req.name - Its name (also the LoRA's file name).
   * @param req.trigger - A word that calls it up in prompts (e.g. "mystyle").
   * @param req.base - The base checkpoint (from kinds()).
   * @param req.images - 5–60 pictures.
   * @param req.steps - Training steps (default 600).
   * @param req.rank - LoRA rank (default 16).
   * @returns The job.
   * @throws Error when it cannot start.
   */
  async startImageLora(req: { name: string; trigger: string; base: string; images: Array<{ data: Uint8Array; mimeType: string }>; steps?: number; rank?: number }): Promise<TrainingJob> {
    if (this.jobs.some((j) => j.status === "running")) throw new Error("A training is already running; wait for it to finish.");
    const comfy = this.deps.comfy();
    if (!comfy.running || !comfy.folder) throw new Error("Start ComfyUI first (the Nodes page).");
    if (req.images.length < 5 || req.images.length > 60) throw new Error("Give 5 to 60 pictures (10–30 is best).");
    const info = await this.deps.objectInfo();
    const dataset = DATASET.find((n) => info[n]);
    const save = SAVE.find((n) => info[n]);
    if (!info.TrainLoraNode || !dataset || !save) throw new Error("This ComfyUI is too old for training: update it on the Nodes page.");
    const ckpts = (info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] as string[] | undefined) ?? [];
    if (!ckpts.includes(req.base)) throw new Error("Choose a base model from the list.");

    const name = slug(req.name);
    const folderName = `kesher-train-${name}`;
    const dir = join(comfy.folder, "input", folderName);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    let i = 0;
    for (const img of req.images) {
      const ext = img.mimeType === "image/png" ? "png" : img.mimeType === "image/webp" ? "webp" : "jpg";
      await writeFile(join(dir, `${String(++i).padStart(3, "0")}.${ext}`), img.data);
    }
    const steps = Math.max(50, Math.min(5000, Math.round(req.steps ?? 600)));
    const rank = Math.max(4, Math.min(64, Math.round(req.rank ?? 16)));
    const trigger = req.trigger.trim().replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 40) || name;
    const prefix = `loras/kesher-${name}`;
    const flow: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: req.base } },
      "2": { class_type: dataset, inputs: { folder: folderName, ...(info[dataset]?.input?.required?.resize_method ? { resize_method: "None" } : {}) } },
      "3": { class_type: "VAEEncode", inputs: { pixels: ["2", 0], vae: ["1", 2] } },
      "4": { class_type: "CLIPTextEncode", inputs: { text: trigger, clip: ["1", 1] } },
      "5": {
        class_type: "TrainLoraNode",
        inputs: {
          model: ["1", 0], latents: ["3", 0], positive: ["4", 0], batch_size: 1, grad_accumulation_steps: 1, steps, learning_rate: 0.0005, rank,
          optimizer: "AdamW", loss_function: "MSE", seed: Math.floor(Math.random() * 2 ** 31), training_dtype: "bf16", lora_dtype: "bf16",
          algorithm: "LoRA", gradient_checkpointing: true, existing_lora: "[None]",
        },
      },
      "6": { class_type: save, inputs: { lora: ["5", 0], prefix, steps: ["5", 2] } },
    };
    fillDefaults(flow, info);
    const job: TrainingJob = { id: randomUUID(), kind: "image-lora", name, base: req.base, status: "running", startedAt: new Date().toISOString(), steps };
    this.jobs.push(job);
    this.abort = new AbortController();
    const started = Date.now();
    void this.deps
      .runFlow(flow, this.abort.signal)
      .then(async () => {
        // SaveLoRA writes to ComfyUI's output/loras: take the newest file it made, and put it where pictures find LoRAs.
        const out = join(comfy.folder!, "output", "loras");
        const files = await readdir(out).catch(() => [] as string[]);
        const made = (await Promise.all(files.filter((f) => f.startsWith(`kesher-${name}`) && f.endsWith(".safetensors")).map(async (f) => ({ f, t: (await stat(join(out, f))).mtimeMs }))))
          .filter((x) => x.t >= started - 1000)
          .sort((a, b) => b.t - a.t)[0];
        if (!made) throw new Error("ComfyUI finished but saved no LoRA.");
        await mkdir(this.deps.loraDir(), { recursive: true });
        const file = `${name}.safetensors`;
        await copyFile(join(out, made.f), join(this.deps.loraDir(), file));
        // ComfyUI's own flows can use it too.
        const comfyLoras = join(comfy.folder!, "models", "loras");
        if (existsSync(join(comfy.folder!, "models"))) await mkdir(comfyLoras, { recursive: true }).then(() => copyFile(join(out, made.f), join(comfyLoras, file))).catch(() => undefined);
        Object.assign(job, { status: "done", file, finishedAt: new Date().toISOString(), message: `Done. Use it on the Images page (LoRA "${name}"), and write "${trigger}" in the prompt.` });
      })
      .catch((e: Error) => Object.assign(job, { status: "error", finishedAt: new Date().toISOString(), message: /out of memory|allocation on device/i.test(e.message) ? "The graphics card ran out of memory: try SD 1.5, fewer steps or a lower rank." : e.message }))
      .finally(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
    return job;
  }

  /** Stops the running training. */
  stop(): void {
    this.abort?.abort();
    void this.deps.interrupt?.().catch(() => undefined);
  }
}
