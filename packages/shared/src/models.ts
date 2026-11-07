import { z } from "zod";

/**
 * Where a model runs. Used for the "local" / "server" / "cloud" badge in the
 * UI and for the "local only" switch that hides everything else.
 */
export const ModelLocationSchema = z.enum(["local", "server", "cloud"]);

/** Where a model runs; see {@link ModelLocationSchema}. */
export type ModelLocation = z.infer<typeof ModelLocationSchema>;

/**
 * A model as the rest of the app sees it, regardless of which provider
 * serves it.
 */
export const ModelInfoSchema = z.object({
  /** Globally unique id: `<providerId>/<providerModelId>`. Build it with {@link makeModelId}. */
  id: z.string(),
  /** The provider that serves this model, e.g. `lmstudio` or `comfyui`. */
  providerId: z.string(),
  /** The id the provider itself uses, e.g. `qwen3-14b` or `flux1-dev.safetensors`. */
  providerModelId: z.string(),
  /** Human-readable name. */
  name: z.string(),
  /** Category id, see `categories.ts`. */
  category: z.string(),
  location: ModelLocationSchema,
  /** Optional free-form details such as quantization or context length. */
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/** A model as the rest of the app sees it; see {@link ModelInfoSchema}. */
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/** The two halves of a model id. */
export interface ModelRef {
  /** Id of the provider that serves the model. */
  providerId: string;
  /** Id the provider uses for the model. */
  providerModelId: string;
}

/**
 * Builds a global model id from its provider and the provider's own id.
 *
 * @param providerId - e.g. `ollama`.
 * @param providerModelId - e.g. `llama3.2:3b`. May itself contain slashes.
 * @returns `"<providerId>/<providerModelId>"`.
 */
export function makeModelId(providerId: string, providerModelId: string): string {
  return `${providerId}/${providerModelId}`;
}

/**
 * Splits a global model id back into its provider and provider model id.
 * Only the first slash separates them, so provider ids may not contain one
 * but provider model ids (like `Qwen/Qwen3-14B`) may.
 *
 * @param modelId - A string produced by {@link makeModelId}.
 * @returns The two halves.
 * @throws Error if the id has no slash.
 */
export function parseModelId(modelId: string): ModelRef {
  const slash = modelId.indexOf("/");
  if (slash <= 0) throw new Error(`Invalid model id "${modelId}": expected "<provider>/<model>"`);
  return { providerId: modelId.slice(0, slash), providerModelId: modelId.slice(slash + 1) };
}
