/**
 * Model categories.
 *
 * A category decides which screen a model appears on and which tool it
 * exposes to chat models (see `toolName`). The built-in list covers what
 * KesherAI ships with; plugins add more through
 * `PluginContext.registerCategory` in `@kesher/plugin-sdk`.
 *
 * @packageDocumentation
 */

/** Identifier of a built-in category. Plugins may add any other string. */
export type BuiltInCategoryId =
  | "chat"
  | "image"
  | "video"
  | "speech-to-text"
  | "text-to-speech"
  | "music"
  | "embedding"
  | "3d";

/** A category id: one of the built-ins, or a string a plugin registered. */
export type CategoryId = BuiltInCategoryId | (string & {});

/** Describes one category of models. */
export interface CategoryDefinition {
  /** Stable identifier, used in model ids, config files and URLs. */
  id: CategoryId;
  /** Display names keyed by locale (`en` is required as the fallback). */
  label: { en: string } & Record<string, string>;
  /**
   * Name of the tool this category exposes to chat models, e.g.
   * `generate_image`. Omit for categories chat models should not call.
   */
  toolName?: string;
  /**
   * Hugging Face `pipeline_tag` values that map to this category. Used to
   * auto-categorise models found through the in-app downloader.
   */
  huggingFacePipelineTags?: string[];
}

/** The categories KesherAI knows about out of the box. */
export const BUILT_IN_CATEGORIES: readonly CategoryDefinition[] = [
  {
    id: "chat",
    label: { en: "Chat & code", he: "צ'אט וקוד" },
    huggingFacePipelineTags: ["text-generation", "image-text-to-text"],
  },
  {
    id: "image",
    label: { en: "Images", he: "תמונות" },
    toolName: "generate_image",
    huggingFacePipelineTags: ["text-to-image", "image-to-image"],
  },
  {
    id: "video",
    label: { en: "Video", he: "וידאו" },
    toolName: "generate_video",
    huggingFacePipelineTags: ["text-to-video", "image-to-video"],
  },
  {
    id: "speech-to-text",
    label: { en: "Speech to text", he: "דיבור לטקסט" },
    toolName: "transcribe",
    huggingFacePipelineTags: ["automatic-speech-recognition"],
  },
  {
    id: "text-to-speech",
    label: { en: "Text to speech", he: "טקסט לדיבור" },
    toolName: "speak",
    huggingFacePipelineTags: ["text-to-speech", "text-to-audio"],
  },
  {
    id: "music",
    label: { en: "Music & SFX", he: "מוזיקה ואפקטים" },
    toolName: "generate_audio",
  },
  {
    id: "embedding",
    label: { en: "Embeddings", he: "Embeddings" },
    huggingFacePipelineTags: ["feature-extraction", "sentence-similarity"],
  },
  {
    id: "3d",
    label: { en: "3D", he: "תלת-ממד" },
    toolName: "generate_3d",
    huggingFacePipelineTags: ["image-to-3d", "text-to-3d"],
  },
];

/**
 * Finds the category that claims a Hugging Face `pipeline_tag`.
 *
 * @param pipelineTag - The tag from the Hugging Face model card, e.g. `text-to-image`.
 * @param categories - Categories to search; defaults to the built-ins.
 * @returns The matching category id, or `undefined` if none claims the tag.
 *
 * @example
 * ```ts
 * categoryForPipelineTag("text-to-image"); // "image"
 * ```
 */
export function categoryForPipelineTag(
  pipelineTag: string | undefined,
  categories: readonly CategoryDefinition[] = BUILT_IN_CATEGORIES,
): CategoryId | undefined {
  if (!pipelineTag) return undefined;
  return categories.find((c) => c.huggingFacePipelineTags?.includes(pipelineTag))?.id;
}
