import { z } from "zod";

/** Body of `POST /api/images`. */
export const ImageRequestSchema = z.object({
  /** Global model id of an `image` model, e.g. `comfyui/flux1-dev.safetensors`. */
  modelId: z.string(),
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  width: z.number().int().min(64).max(4096).default(1024),
  height: z.number().int().min(64).max(4096).default(1024),
  steps: z.number().int().min(1).max(200).default(20),
  /** Omit for a random seed. */
  seed: z.number().int().nonnegative().optional(),
  /** Start from this picture (PNG, base64): image to image. */
  initImage: z.string().max(40_000_000).optional(),
  /** With `initImage`: white where to paint, black where to keep (PNG, base64): inpainting. */
  mask: z.string().max(40_000_000).optional(),
  /** With `initImage`: how much to change it, 0–1 (default 0.75). */
  strength: z.number().min(0).max(1).optional(),
});

/** Body of `POST /api/images`; see {@link ImageRequestSchema}. */
export type ImageRequest = z.infer<typeof ImageRequestSchema>;

/** Kinds of file the Asset Store keeps. */
export type AssetKind = "image" | "video" | "audio" | "text" | "file";

/**
 * A generated or imported file. Every model output becomes an asset, so any
 * other model (or a Pipeline node) can take it as input by id.
 */
export interface Asset {
  /** Random id; the file is served at `/api/assets/<id>`. */
  id: string;
  kind: AssetKind;
  /** MIME type, e.g. `image/png`. */
  mimeType: string;
  /** ISO timestamp. */
  createdAt: string;
  /** The model that produced it, if any. */
  sourceModelId?: string;
  /** Free-form metadata such as the prompt and seed. */
  meta?: Record<string, unknown>;
}
