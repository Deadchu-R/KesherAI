/**
 * Vision models that are already on the computer but not in the catalog (vision-models.ts): any Qwen-VL or UI-TARS
 * GGUF the normal model downloader saved, with the projector (`mmproj`) file beside it (any chat model with one can see). They are a usable choice for
 * "auto", so computer and browser control works without downloading anything. Nothing here downloads.
 */
import { LOCAL_VISION_ID, type VisionCoords, type VisionModel } from "@kesher/shared";
import { listGgufFiles } from "./gguf-scan.js";

/** A vision model found on the computer. */
export interface LocalVision {
  /** A short display name (the file name without `.gguf`). */
  name: string;
  files: { model: string; mmproj: string };
  /** How the model writes the point it found. */
  coords: VisionCoords;
}

/** The last part of a path (either separator). */
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
/** A path's folder. */
const folderOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));

/**
 * The point format of a vision model, from its file name: Qwen3-VL writes 0 to 1000 of the picture, Qwen2/2.5-VL and
 * UI-TARS write pixels of the resized picture. Other families are not known to work, so they give undefined.
 *
 * @param file - The model file's name.
 */
export function visionCoordsOf(file: string): VisionCoords | undefined {
  const n = baseName(file);
  if (/qwen[-_. ]?3(?:[-_.]?\d+)?[-_. ]?vl/i.test(n)) return "rel1000";
  if (/qwen[-_. ]?2(?:[-_.]?5)?[-_. ]?vl|ui[-_. ]?tars/i.test(n)) return "abs28";
  return undefined;
}

/** How much "auto" likes a model (lower first): gemma-4-12b fits beside other models on a 24 GB card, then Qwen3-VL, then the other known families. */
function visionRank(name: string): number {
  if (/gemma[-_. ]?4[-_. ]?12b/i.test(name)) return 0;
  if (/qwen[-_. ]?3(?:[-_.]?\d+)?[-_. ]?vl/i.test(name)) return 1;
  return visionCoordsOf(name) ? 2 : 3;
}

/**
 * Picks the usable vision models out of a list of GGUF files: any model file with an `mmproj` file in the same folder
 * (the F16 one first, else the shortest name) can see pictures. Qwen-VL and UI-TARS write points in a known format;
 * for any other family (e.g. Gemma) the Qwen3 format (0 to 1000 of the picture) is asked for, best effort.
 *
 * @param files - Full paths of GGUF files.
 * @returns The usable models in the order "auto" prefers them (see {@link visionRank}, then by name), and the Qwen-VL
 *   / UI-TARS model files that have no projector.
 */
export function pickLocalVision(files: readonly string[]): { usable: LocalVision[]; noProjector: string[] } {
  const usable: LocalVision[] = [];
  const noProjector: string[] = [];
  for (const model of files) {
    const n = baseName(model);
    if (/mmproj/i.test(n)) continue;
    const dir = folderOf(model);
    const mmproj = files
      .filter((f) => folderOf(f) === dir && /^mmproj.*\.gguf$/i.test(baseName(f)))
      .sort((a, b) => Number(/f16/i.test(baseName(b))) - Number(/f16/i.test(baseName(a))) || baseName(a).length - baseName(b).length)[0];
    const known = visionCoordsOf(n);
    if (mmproj) usable.push({ name: n.replace(/\.gguf$/i, ""), files: { model, mmproj }, coords: known ?? "rel1000" });
    else if (known) noProjector.push(model);
  }
  usable.sort((a, b) => visionRank(a.name) - visionRank(b.name) || (a.name < b.name ? -1 : 1));
  return { usable, noProjector };
}

/**
 * Looks for vision models under some folders.
 *
 * @param roots - The folders (the models folder, the vision folder).
 * @returns As {@link pickLocalVision}, over every GGUF under them.
 */
export function findLocalVision(roots: readonly string[]): { usable: LocalVision[]; noProjector: string[] } {
  return pickLocalVision([...new Set(roots.flatMap((r) => listGgufFiles(r)))]);
}

/**
 * The model description the vision service uses for a model found on the computer.
 *
 * @param v - The model found.
 */
export function localVisionModel(v: LocalVision): VisionModel {
  return {
    id: LOCAL_VISION_ID,
    name: v.name,
    repo: "",
    filePattern: "",
    mmprojPattern: "",
    sizeGb: 0,
    mmprojGb: 0,
    vramGb: 8,
    coords: v.coords,
    license: "",
    source: "this computer",
    installId: "vision-model",
    note: { en: "Found on this computer.", he: "נמצא במחשב הזה." },
  };
}
