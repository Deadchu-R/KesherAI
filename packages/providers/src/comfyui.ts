import { randomUUID } from "node:crypto";
import { makeModelId, type ModelInfo, type ModelLocation } from "@kesher/shared";
import type { GeneratedFile, Provider, ProviderConfig, ProviderFactory, ProviderImageRequest } from "./provider.js";
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
  readonly capabilities = { image: true };
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
    return names.map((file) => ({
      id: makeModelId(this.id, file),
      providerId: this.id,
      providerModelId: file,
      name: file.replace(/\.(safetensors|ckpt|gguf)$/i, ""),
      category: "image",
      location: this.location,
    }));
  }

  /** @inheritDoc */
  async generateImage(request: ProviderImageRequest, signal?: AbortSignal): Promise<GeneratedFile[]> {
    const workflow = this.buildWorkflow(request);
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

    const outputs = await this.waitForOutputs(promptId, signal);
    const files: GeneratedFile[] = [];
    for (const image of outputs) {
      const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
      const res = await fetchOk(`${this.baseUrl}/view?${params}`, { signal });
      files.push({
        data: new Uint8Array(await res.arrayBuffer()),
        mimeType: res.headers.get("content-type") ?? "image/png",
        meta: { prompt: request.prompt, seed: request.seed, steps: request.steps, comfyPromptId: promptId },
      });
    }
    return files;
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
  ): Promise<Array<{ filename: string; subfolder: string; type: string }>> {
    const deadline = Date.now() + Number(this.options.timeoutMs ?? 600_000);
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const res = await fetchOk(`${this.baseUrl}/history/${promptId}`, { signal });
      const history = (await res.json()) as Record<
        string,
        {
          status?: { status_str?: string; completed?: boolean };
          outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
        }
      >;
      const entry = history[promptId];
      if (entry?.status?.status_str === "error") throw new Error("ComfyUI reported an error while running the workflow");
      if (entry?.status?.completed) {
        return Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []).filter((i) => i.type === "output");
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Timed out waiting for ComfyUI prompt ${promptId}`);
  }
}

/** Factory for {@link ComfyUIProvider}. */
export const comfyUIFactory: ProviderFactory = {
  type: "comfyui",
  displayName: "ComfyUI",
  categories: ["image", "video", "music", "3d"],
  create: (config) => new ComfyUIProvider(config),
};
