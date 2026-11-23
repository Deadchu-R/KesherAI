/**
 * Local vision models for browser and computer control (docs/research/browser-computer-control.md, Phase 6): a
 * screenshot and "the blue Save button" in, a point on the screen out. They run on the built-in llama.cpp engine in a
 * slot of their own, so the chat's model stays loaded.
 *
 * Each entry names its Hugging Face repository and file patterns (not exact names), so a repository that renames a
 * file keeps working; the sizes are what the repository showed on 2026-11-21 and are only shown to the user (the
 * installer reads the real sizes before it downloads).
 */

/** How a model writes the point it found. */
export type VisionCoords =
  /** `{"point_2d": [x, y]}` from 0 to 1000 of the picture's width and height (Qwen3-VL). */
  | "rel1000"
  /** `(x, y)` in pixels of the picture as the model's own resize made it (multiples of 28: Qwen2.5-VL / UI-TARS). */
  | "abs28";

/** The id of a vision model found on the computer that is not in the catalog (core's vision-local.ts). */
export const LOCAL_VISION_ID = "local-vl";

/** One vision model KesherAI can install for finding things on the screen. */
export interface VisionModel {
  /** Stable id (settings, the API, the Install button's `vision-model…` ids). */
  id: "qwen3-vl-8b" | "ui-tars-1.5-7b" | typeof LOCAL_VISION_ID;
  name: string;
  /** Hugging Face repository. */
  repo: string;
  /** Picks the model file (first match, case-insensitive). */
  filePattern: string;
  /** Picks the vision projector file (first match, case-insensitive). */
  mmprojPattern: string;
  /** The model file's size in GB, as the repository shows it. */
  sizeGb: number;
  /** The projector's size in GB (approximate when `approx`). */
  mmprojGb: number;
  /** Whether a size is a rough figure (the repository's file list could not be read). */
  approx?: boolean;
  /** Memory it needs on the graphics card with an 8k context, GB. */
  vramGb: number;
  coords: VisionCoords;
  license: string;
  /** Who made the GGUF files. */
  source: string;
  /** The Install button's id for it (installables.ts). */
  installId: string;
  note: { en: string; he: string };
}

/** The Models screen's category for these models, and Settings' words for it. */
export const VISION_CATEGORY = { id: "gui-vision", label: { en: "Computer & browser vision", he: "ראייה למחשב ולדפדפן" } } as const;

/** The models, the default first (it is what the chat offers when none is installed). */
export const VISION_MODELS: readonly VisionModel[] = [
  {
    id: "qwen3-vl-8b",
    name: "Qwen3-VL 8B",
    repo: "Qwen/Qwen3-VL-8B-Instruct-GGUF",
    filePattern: "Qwen3VL-8B-Instruct-Q4_K_M\\.gguf$",
    mmprojPattern: "^mmproj-.*F16\\.gguf$",
    sizeGb: 5.03,
    mmprojGb: 1.16,
    vramGb: 8,
    coords: "rel1000",
    license: "Apache-2.0",
    source: "Qwen (official GGUF)",
    installId: "vision-model",
    note: {
      en: "Qwen's own vision model: reads screenshots and points at buttons, icons and fields. The default.",
      he: "מודל הראייה של Qwen: קורא צילומי מסך ומצביע על כפתורים, אייקונים ושדות. ברירת המחדל.",
    },
  },
  {
    id: "ui-tars-1.5-7b",
    name: "UI-TARS-1.5 7B",
    repo: "Mungert/UI-TARS-1.5-7B-GGUF",
    filePattern: "UI-TARS-1\\.5-7B-q4_k_m\\.gguf$|UI-TARS-1\\.5-7B-q4_k\\.gguf$",
    mmprojPattern: "mmproj",
    sizeGb: 4.78,
    mmprojGb: 0.85,
    approx: true,
    vramGb: 7,
    coords: "abs28",
    license: "Apache-2.0",
    source: "Mungert (GGUF of ByteDance-Seed/UI-TARS-1.5-7B)",
    installId: "vision-model-uitars",
    note: {
      en: "ByteDance's model trained to find things on screens (ScreenSpot-Pro 49.6). A second opinion for the test.",
      he: "המודל של ByteDance שאומן למצוא דברים על המסך (ScreenSpot-Pro 49.6). דעה שנייה לבדיקה.",
    },
  },
];

/** What Settings → "Find things on the screen with" may hold. */
export type VisionChoice = "auto" | Exclude<VisionModel["id"], typeof LOCAL_VISION_ID>;

/**
 * The model a choice means, among the installed ones: `auto` takes the first installed in catalog order.
 *
 * @param choice - The setting.
 * @param installed - Ids of the installed models.
 * @returns The model, or undefined when none fits.
 */
export function pickVisionModel(choice: VisionChoice, installed: readonly string[]): VisionModel | undefined {
  if (choice !== "auto") return installed.includes(choice) ? VISION_MODELS.find((m) => m.id === choice) : undefined;
  return VISION_MODELS.find((m) => installed.includes(m.id));
}
