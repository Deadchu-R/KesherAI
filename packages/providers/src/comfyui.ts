import { randomUUID } from "node:crypto";
import { makeModelId, type ModelInfo, type ModelLocation } from "@kesher/shared";
import type { GeneratedFile, Provider, ProviderConfig, ProviderFactory, ProviderImageRequest, ProviderVideoRequest } from "./provider.js";
import { fetchOk } from "./sse.js";

/** A ComfyUI workflow in "API format": node id → `{ class_type, inputs }`. */
export type ComfyWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/**
 * Builds the default text-to-image workflow: one checkpoint, positive and
 * negative prompts, KSampler, VAE decode, save. Works with any
 * all-in-one checkpoint (SD 1.5, SDXL, and Flux checkpoints packaged as a
 * single file).
 *
 * To use your own workflow, export it from ComfyUI with
 * "Export (API)" and pass it as `options.workflow` together with
 * `options.promptNodeId` — see {@link ComfyUIProvider}.
 *
 * @param req - Image request.
 * @returns A workflow ready for `POST /prompt`.
 */
export function defaultTextToImageWorkflow(req: ProviderImageRequest): ComfyWorkflow {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: req.providerModelId } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: req.prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: req.negativePrompt ?? "", clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: req.width, height: req.height, batch_size: 1 } },
    "5": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0],
        seed: req.seed, steps: req.steps, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1,
      },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "kesher" } },
  };
}

/**
 * Provider for a ComfyUI server (local or remote), using its native API:
 * `POST /prompt` to queue a workflow, `GET /history/<id>` to wait for it,
 * `GET /view` to fetch the output files.
 *
 * Models are the checkpoints ComfyUI reports through
 * `GET /object_info/CheckpointLoaderSimple`.
 *
 * Options (`ProviderConfig.options`):
 * - `workflow` (ComfyWorkflow): a custom API-format workflow to run instead
 *   of the default. KesherAI writes the prompt into
 *   `workflow[promptNodeId].inputs.text`.
 * - `promptNodeId` (string): node that receives the prompt in a custom workflow.
 * - `timeoutMs` (number, default 600000): how long to wait for a result.
 */
export class ComfyUIProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly location: ModelLocation;
  readonly capabilities = { image: true, video: true };
  private readonly baseUrl: string;
  private readonly options: Record<string, unknown>;

  /** @param config - `baseUrl` defaults to `http://127.0.0.1:8188`. */
  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.name = config.name ?? "ComfyUI";
    this.location = config.location ?? "local";
    this.baseUrl = (config.baseUrl ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
    this.options = config.options ?? {};
  }

  /** @inheritDoc */
  async checkHealth(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/system_stats`, { signal: signal ?? AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** @inheritDoc */
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await fetchOk(`${this.baseUrl}/object_info/CheckpointLoaderSimple`, { signal });
    const info = (await res.json()) as {
      CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: [string[]] } } };
    };
    const names = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    // The models folder is shared with KesherAI's own engines: leave out video models and text encoders.
    const images: ModelInfo[] = names.filter((f) => !/wan2[._]?[12]|umt5|t5xxl|text_encoder|ace_step|hunyuan3d|(^|[\\/])(video|music|3d)[\\/]/i.test(f)).map((file) => ({
      id: makeModelId(this.id, file),
      providerId: this.id,
      providerModelId: file,
      name: file.replace(/\.(safetensors|ckpt|gguf)$/i, ""),
      category: "image",
      location: this.location,
    }));
    // Video: Wan text-to-video models in diffusion_models (they need a umt5 text encoder and the Wan VAE).
    const videos = (await this.choices("UNETLoader", "unet_name", signal).catch(() => [] as string[]))
      .filter((f) => /wan2[._]?[12].*t2v/i.test(f))
      .map((file) => ({
        id: makeModelId(this.id, file),
        providerId: this.id,
        providerModelId: file,
        name: `${file.split(/[\\/]/).pop()!.replace(/\.(safetensors|gguf)$/i, "")} (ComfyUI)`,
        category: "video" as const,
        location: this.location,
      }));
    return [...images, ...videos];
  }

  /** The options ComfyUI offers for one input of a node (e.g. the files in a model folder). */
  private async choices(node: string, input: string, signal?: AbortSignal): Promise<string[]> {
    const res = await fetchOk(`${this.baseUrl}/object_info/${node}`, { signal });
    const info = (await res.json()) as Record<string, { input?: { required?: Record<string, [unknown]> } }>;
    const list = info[node]?.input?.required?.[input]?.[0];
    return Array.isArray(list) ? list.map(String) : [];
  }

  /**
   * Makes a short clip with a Wan 2.1 text-to-video model (ComfyUI's own
   * example workflow: about 2 seconds at 16 frames a second, 832×480).
   */
  async generateVideo(request: ProviderVideoRequest, signal?: AbortSignal): Promise<GeneratedFile[]> {
    const [encoders, vaes] = await Promise.all([this.choices("CLIPLoader", "clip_name", signal), this.choices("VAELoader", "vae_name", signal)]);
    const encoder = encoders.find((f) => /umt5/i.test(f) && !/\.gguf$/i.test(f));
    const vae = vaes.find((f) => /wan.*vae|vae.*wan/i.test(f));
    if (!encoder || !vae) throw new Error(`ComfyUI is missing Wan's ${!encoder ? "text encoder (umt5_xxl in models/text_encoders)" : "VAE (wan_2.1_vae in models/vae)"}. Press "Set up Wan in ComfyUI" on the Models page → Video.`);
    const frames = Math.max(1, Math.round(((request.seconds ?? 2) * 16) / 4)) * 4 + 1;
    const workflow: ComfyWorkflow = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: request.providerModelId, weight_dtype: "default" } },
      "2": { class_type: "CLIPLoader", inputs: { clip_name: encoder, type: "wan", device: "default" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: vae } },
      "4": { class_type: "ModelSamplingSD3", inputs: { shift: 8, model: ["1", 0] } },
      "5": { class_type: "CLIPTextEncode", inputs: { text: request.prompt, clip: ["2", 0] } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: request.negativePrompt ?? "blurry, low quality, distorted, static, still image", clip: ["2", 0] } },
      "7": { class_type: "EmptyHunyuanLatentVideo", inputs: { width: 832, height: 480, length: Math.min(81, frames), batch_size: 1 } },
      "8": { class_type: "KSampler", inputs: { seed: request.seed ?? Math.floor(Math.random() * 2 ** 31), steps: 30, cfg: 6, sampler_name: "uni_pc", scheduler: "simple", denoise: 1, model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0] } },
      "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
      "10": { class_type: "SaveAnimatedWEBP", inputs: { filename_prefix: "KesherAI/video", fps: 16, lossless: false, quality: 90, method: "default", images: ["9", 0] } },
    };
    return this.run(workflow, { prompt: request.prompt, seed: request.seed }, signal, 30 * 60_000);
  }

  /** @inheritDoc */
  async generateImage(request: ProviderImageRequest, signal?: AbortSignal): Promise<GeneratedFile[]> {
    return this.run(this.buildWorkflow(request), { prompt: request.prompt, seed: request.seed, steps: request.steps }, signal);
  }

  /** Queues a workflow, waits for it, and fetches what it saved. */
  private async run(workflow: ComfyWorkflow, meta: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<GeneratedFile[]> {
    const queued = await fetchOk(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
    });
    const { prompt_id: promptId, node_errors: nodeErrors } = (await queued.json()) as {
      prompt_id: string;
      node_errors?: Record<string, unknown>;
    };
    if (nodeErrors && Object.keys(nodeErrors).length > 0) {
      throw new Error(`ComfyUI rejected the workflow: ${JSON.stringify(nodeErrors).slice(0, 500)}`);
    }

    const outputs = await this.waitForOutputs(promptId, signal, timeoutMs);
    const files: GeneratedFile[] = [];
    for (const image of outputs) {
      const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
      const res = await fetchOk(`${this.baseUrl}/view?${params}`, { signal });
      files.push({
        data: new Uint8Array(await res.arrayBuffer()),
        mimeType: res.headers.get("content-type") ?? "image/png",
        meta: { ...meta, comfyPromptId: promptId },
      });
    }
    return files;
  }

  /**
   * Runs any flow in ComfyUI's API format (music, 3D, …) and returns every
   * file it saved: pictures, sound, 3D models.
   *
   * @param flow - The flow.
   * @param signal - Cancels the wait.
   * @param timeoutMs - How long to wait (default 30 minutes).
   * @returns The saved files with their names.
   */
  async runFlow(flow: ComfyWorkflow, signal?: AbortSignal, timeoutMs = 30 * 60_000): Promise<Array<GeneratedFile & { filename: string }>> {
    const queued = await fetchOk(`${this.baseUrl}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, signal, body: JSON.stringify({ prompt: flow, client_id: randomUUID() }) });
    const { prompt_id: promptId, node_errors: nodeErrors } = (await queued.json()) as { prompt_id: string; node_errors?: Record<string, unknown> };
    if (nodeErrors && Object.keys(nodeErrors).length > 0) throw new Error(`ComfyUI rejected the flow: ${JSON.stringify(nodeErrors).slice(0, 500)}`);
    const outputs = await this.waitForOutputs(promptId, signal, timeoutMs);
    const files: Array<GeneratedFile & { filename: string }> = [];
    for (const o of outputs) {
      const params = new URLSearchParams({ filename: o.filename, subfolder: o.subfolder, type: o.type });
      const res = await fetchOk(`${this.baseUrl}/view?${params}`, { signal });
      files.push({ data: new Uint8Array(await res.arrayBuffer()), mimeType: mimeFor(o.filename, res.headers.get("content-type")), filename: o.filename, meta: { comfyPromptId: promptId } });
    }
    return files;
  }

  /**
   * Puts a picture into ComfyUI's input folder (for a Load Image node).
   *
   * @param data - The picture.
   * @param name - Its file name.
   * @returns The name to put in the Load Image node.
   */
  async uploadImage(data: Uint8Array, name: string): Promise<string> {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(data)]), name);
    form.append("overwrite", "true");
    const res = await fetchOk(`${this.baseUrl}/upload/image`, { method: "POST", body: form });
    const j = (await res.json()) as { name: string; subfolder?: string };
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }

  private buildWorkflow(request: ProviderImageRequest): ComfyWorkflow {
    const custom = this.options.workflow as ComfyWorkflow | undefined;
    if (!custom) return defaultTextToImageWorkflow(request);
    const workflow = structuredClone(custom);
    const nodeId = String(this.options.promptNodeId ?? "");
    const node = workflow[nodeId];
    if (!node) throw new Error(`Custom workflow has no node "${nodeId}" (options.promptNodeId)`);
    node.inputs.text = request.prompt;
    return workflow;
  }

  private async waitForOutputs(
    promptId: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<Array<{ filename: string; subfolder: string; type: string }>> {
    const deadline = Date.now() + (timeoutMs ?? Number(this.options.timeoutMs ?? 600_000));
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const res = await fetchOk(`${this.baseUrl}/history/${promptId}`, { signal });
      const history = (await res.json()) as Record<
        string,
        {
          status?: { status_str?: string; completed?: boolean };
          outputs?: Record<string, Record<string, unknown>>;
        }
      >;
      const entry = history[promptId];
      if (entry?.status?.status_str === "error") throw new Error("ComfyUI reported an error while running the workflow");
      if (entry?.status?.completed) {
        // Pictures are under "images", sound under "audio", 3D models under "3d" (and so on): take every saved file.
        return Object.values(entry.outputs ?? {})
          .flatMap((o) => Object.values(o).flatMap((v) => (Array.isArray(v) ? v : [])))
          .filter((i): i is { filename: string; subfolder: string; type: string } => !!i && typeof i === "object" && typeof (i as { filename?: unknown }).filename === "string")
          .filter((i) => i.type === "output");
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Timed out waiting for ComfyUI prompt ${promptId}`);
  }
}

/** A file's type from its name, when ComfyUI does not say. */
function mimeFor(name: string, header: string | null): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const known: Record<string, string> = { mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", opus: "audio/ogg", ogg: "audio/ogg", glb: "model/gltf-binary", gltf: "model/gltf+json", obj: "model/obj", png: "image/png", jpg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" };
  return known[ext] ?? (header && header !== "application/octet-stream" ? header.split(";")[0]! : "application/octet-stream");
}

/** Factory for {@link ComfyUIProvider}. */
export const comfyUIFactory: ProviderFactory = {
  type: "comfyui",
  displayName: "ComfyUI",
  categories: ["image", "video", "music", "3d"],
  create: (config) => new ComfyUIProvider(config),
};
