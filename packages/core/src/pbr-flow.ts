/**
 * One request to a tileable PBR material (WORK_LIST "ComfyUI to Unity demo"): ComfyUI makes a seamless albedo, a
 * seam check fixes it when it does not tile, and the normal, roughness, AO and height maps are worked out from the
 * albedo on this computer, the way Materialize, Substance's "bitmap to material" and ArmorLab's albedo pass do it.
 *
 * Why the maps are made here and not in ComfyUI: standard ComfyUI has no normal, roughness or AO nodes, and the
 * normal estimators of the common custom nodes (BAE, DSINE) are trained on photos of rooms, not flat textures. A
 * height from the albedo's light and Sobel normals are the classic "from a picture" result, they work with any
 * checkpoint, and every filter here wraps around the edges, so the maps tile exactly like the albedo.
 *
 * The graphs are in ComfyUI's API format and use only ComfyUI's own nodes, plus spinagon's ComfyUI-seamless-tiling
 * (SeamlessTile, CircularVAEDecode) when ComfyUI has it: the model and VAE then pad circularly, so the picture tiles
 * as it is made. Without it (or with a model whose layers do not pad, like FLUX) the seam check catches the seam and
 * the fix graph moves the picture half its size and paints over the cross where the edges meet (offset + inpaint,
 * with core nodes only).
 */
import { deflateSync } from "node:zlib";
import type { JobProgress } from "@kesher/shared";
import { decodePng } from "./design-png.js";

/** A node of a graph in ComfyUI's API format. */
export interface GraphNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title: string };
}

/** A graph in ComfyUI's API format. */
export type ApiGraph = Record<string, GraphNode>;

/** What the PBR and sprite tools need from ComfyUI (server/build-conversations.ts makes it; tests fake it). */
export interface ComfyGraphRunner {
  /** Whether ComfyUI is installed, and allowed by business mode. */
  state(): { installed: boolean; allowed: boolean };
  /** The node classes ComfyUI has now (its /object_info); starts ComfyUI when it is not running. */
  nodes(signal: AbortSignal): Promise<Set<string>>;
  /** The files in ComfyUI's checkpoints folder. */
  checkpoints(): Promise<string[]>;
  /**
   * Runs a graph and returns what it saved.
   *
   * @param build - Makes the graph; `upload` puts a picture into ComfyUI's input folder and returns its name.
   * @param signal - Stop.
   * @param onProgress - Live steps and preview frames.
   */
  run(
    build: (upload: (data: Uint8Array, name: string) => Promise<string>) => Promise<ApiGraph> | ApiGraph,
    signal: AbortSignal,
    onProgress?: (p: JobProgress) => void,
  ): Promise<Array<{ data: Uint8Array; mimeType: string; filename: string }>>;
}

/** ComfyUI's own nodes the albedo graph needs. */
export const CORE_NODES = ["CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage"] as const;
/** spinagon/ComfyUI-seamless-tiling: a model and a VAE that pad circularly. */
export const TILING_NODES = ["SeamlessTile", "CircularVAEDecode"] as const;
/** ComfyUI's own nodes the seam fix (offset + inpaint) needs. */
export const FIX_NODES = ["LoadImage", "ImageCrop", "ImageCompositeMasked", "SolidMask", "MaskComposite", "VAEEncodeForInpaint", "GrowMask"] as const;

/** Checkpoints that are not picture models (music, sound, video, 3D) or not checkpoints at all. */
const NOT_PICTURE = /ace[_-]?step|stable[_-]?audio|audio|music|wan2|hunyuan|trellis|ltx|cosmos|svd|video|(^|[\\/])(3d|chat|embedding|speech|music|video)[\\/]|vae|clip|t5|umt5|lora/i;

/**
 * The checkpoint to make the texture with: the user's active image model when ComfyUI has it, else the first picture
 * checkpoint, preferring SDXL-sized ones (1024 px textures).
 *
 * @param list - ComfyUI's checkpoints.
 * @param active - The active image model's file, when it is a ComfyUI one.
 * @returns The file name, or undefined when there is none.
 */
export function pickCheckpoint(list: readonly string[], active?: string): string | undefined {
  const pictures = list.filter((f) => !NOT_PICTURE.test(f));
  if (active && pictures.includes(active)) return active;
  return pictures.find((f) => /xl|flux|sd3/i.test(f)) ?? pictures[0];
}

/** Sampler settings and size for one checkpoint family. */
export interface SamplerSettings {
  size: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
}

/**
 * Sampler settings by the checkpoint's name: FLUX (cfg 1; schnell 4 steps), turbo/lightning/LCM (few steps, low cfg),
 * SDXL-sized (1024 px) and SD 1.5 (512 px).
 *
 * @param ckpt - The checkpoint's file name.
 */
export function samplerFor(ckpt: string): SamplerSettings {
  if (/flux/i.test(ckpt)) return { size: 1024, steps: /schnell/i.test(ckpt) ? 4 : 20, cfg: 1, sampler: "euler", scheduler: "simple" };
  const big = /xl|sd3|pony|illustrious/i.test(ckpt);
  if (/turbo|lightning|hyper|lcm/i.test(ckpt)) return { size: big ? 1024 : 512, steps: 8, cfg: 2, sampler: "euler", scheduler: "sgm_uniform" };
  return { size: big ? 1024 : 512, steps: 25, cfg: 6, sampler: "dpmpp_2m", scheduler: "karras" };
}

/** Words added to every texture prompt: a flat, evenly lit, top-down surface (what a material needs). */
export const TEXTURE_WORDS = "seamless tileable texture, flat top-down orthographic view, evenly lit, no shadows, no perspective, highly detailed surface";
/** Words the texture must not have. */
export const TEXTURE_NEGATIVE = "perspective, horizon, vignette, border, frame, text, watermark, logo, shadows, objects, people, blurry, low quality";

/**
 * The albedo graph: checkpoint → (SeamlessTile) → KSampler → (CircularVAEDecode | VAEDecode) → SaveImage.
 *
 * @param o.ckpt - The checkpoint; `o.prompt` the user's words (English); `o.count` pictures in one batch (1-4).
 * @param o.tiling - Whether ComfyUI has the seamless-tiling nodes.
 * @param o.seed - The seed.
 * @returns The graph.
 */
export function albedoGraph(o: { ckpt: string; prompt: string; count: number; tiling: boolean; seed: number }): ApiGraph {
  const s = samplerFor(o.ckpt);
  const graph: ApiGraph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: o.ckpt }, _meta: { title: "Checkpoint" } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: `${o.prompt.slice(0, 1000)}, ${TEXTURE_WORDS}`, clip: ["1", 1] }, _meta: { title: "Texture" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: TEXTURE_NEGATIVE, clip: ["1", 1] } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: s.size, height: s.size, batch_size: Math.min(4, Math.max(1, Math.round(o.count))) } },
    "6": { class_type: "KSampler", inputs: { model: o.tiling ? ["2", 0] : ["1", 0], positive: ["3", 0], negative: ["4", 0], latent_image: ["5", 0], seed: o.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, denoise: 1 } },
    "7": o.tiling
      ? { class_type: "CircularVAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2], tiling: "enable" } }
      : { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2] } },
    "8": { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: "KesherAI/pbr" } },
  };
  if (o.tiling) graph["2"] = { class_type: "SeamlessTile", inputs: { model: ["1", 0], tiling: "enable", copy_model: "Make a copy" }, _meta: { title: "Tile while sampling" } };
  return graph;
}

/**
 * The seam fix graph (core nodes only): the picture moved by half its size (four crops put back crosswise), so its
 * edges meet in a cross in the middle; the cross is painted over (VAEEncodeForInpaint) and put back with a slightly
 * grown mask, so the rest stays pixel for pixel. The new edges were neighbours in the picture, so it tiles.
 *
 * @param o.image - The uploaded picture's name; `o.w`, `o.h` its size (even).
 * @param o.ckpt - The checkpoint; `o.prompt` the user's words; `o.seed` the seed.
 * @returns The graph.
 */
export function seamFixGraph(o: { image: string; w: number; h: number; ckpt: string; prompt: string; seed: number }): ApiGraph {
  const s = samplerFor(o.ckpt);
  const hw = Math.floor(o.w / 2);
  const hh = Math.floor(o.h / 2);
  const band = Math.max(32, Math.round(Math.min(o.w, o.h) / 16) * 2);
  const crop = (x: number, y: number): GraphNode => ({ class_type: "ImageCrop", inputs: { image: ["10", 0], width: hw, height: hh, x, y } });
  const put = (dest: string, src: string, x: number, y: number): GraphNode => ({ class_type: "ImageCompositeMasked", inputs: { destination: [dest, 0], source: [src, 0], x, y, resize_source: false } });
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: o.ckpt } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: `${o.prompt.slice(0, 1000)}, ${TEXTURE_WORDS}`, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: TEXTURE_NEGATIVE, clip: ["1", 1] } },
    "10": { class_type: "LoadImage", inputs: { image: o.image }, _meta: { title: "Albedo" } },
    // The quarter that goes to each corner of the moved picture.
    "11": crop(hw, hh),
    "12": crop(0, hh),
    "13": crop(hw, 0),
    "14": crop(0, 0),
    "15": put("10", "11", 0, 0),
    "16": put("15", "12", hw, 0),
    "17": put("16", "13", 0, hh),
    "18": put("17", "14", hw, hh),
    // The cross where the old edges meet.
    "20": { class_type: "SolidMask", inputs: { value: 0, width: o.w, height: o.h } },
    "21": { class_type: "SolidMask", inputs: { value: 1, width: band, height: o.h } },
    "22": { class_type: "SolidMask", inputs: { value: 1, width: o.w, height: band } },
    "23": { class_type: "MaskComposite", inputs: { destination: ["20", 0], source: ["21", 0], x: hw - band / 2, y: 0, operation: "add" } },
    "24": { class_type: "MaskComposite", inputs: { destination: ["23", 0], source: ["22", 0], x: 0, y: hh - band / 2, operation: "add" } },
    "25": { class_type: "VAEEncodeForInpaint", inputs: { pixels: ["18", 0], vae: ["1", 2], mask: ["24", 0], grow_mask_by: 16 } },
    "26": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["25", 0], seed: o.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, denoise: 1 } },
    "27": { class_type: "VAEDecode", inputs: { samples: ["26", 0], vae: ["1", 2] } },
    "28": { class_type: "GrowMask", inputs: { mask: ["24", 0], expand: 8, tapered_corners: true } },
    "29": { class_type: "ImageCompositeMasked", inputs: { destination: ["18", 0], source: ["27", 0], x: 0, y: 0, resize_source: false, mask: ["28", 0] } },
    "30": { class_type: "SaveImage", inputs: { images: ["29", 0], filename_prefix: "KesherAI/pbr-fixed" } },
  };
}

/** Node classes a set needs that ComfyUI does not have. */
export function missingNodes(have: ReadonlySet<string>, need: readonly string[]): string[] {
  return need.filter((n) => !have.has(n));
}

/** A picture as one byte per channel: grey (1), RGB (3) or RGBA (4). */
export interface Picture {
  w: number;
  h: number;
  ch: number;
  data: Uint8Array;
}

/**
 * Reads a PNG ComfyUI saved (8-bit grey, RGB or RGBA).
 *
 * @returns The picture, or undefined for a PNG this reader does not handle.
 */
export function readPicture(png: Uint8Array): Picture | undefined {
  try {
    const p = decodePng(Buffer.from(png));
    return { w: p.w, h: p.h, ch: p.ch, data: p.data };
  } catch {
    return undefined;
  }
}

/** Each pixel's lightness (Rec. 601 weights), 0-255. */
export function luminance(p: Picture): Float32Array {
  const out = new Float32Array(p.w * p.h);
  for (let i = 0; i < out.length; i++) {
    const o = i * p.ch;
    out[i] = p.ch >= 3 ? 0.299 * p.data[o]! + 0.587 * p.data[o + 1]! + 0.114 * p.data[o + 2]! : p.data[o]!;
  }
  return out;
}

/**
 * How visible the seam is where the picture meets itself when tiled: the mean colour step across the wrap-around
 * edges divided by the mean step between neighbouring pixels inside. About 1 tiles; above {@link SEAM_LIMIT} shows.
 *
 * @param p - The picture.
 * @returns The ratio (1 for a picture too small to judge).
 */
export function seamScore(p: Picture): number {
  const lum = luminance(p);
  const { w, h } = p;
  if (w < 4 || h < 4) return 1;
  const at = (x: number, y: number) => lum[y * w + x]!;
  let seam = 0;
  let inner = 0;
  let innerN = 0;
  for (let y = 0; y < h; y++) seam += Math.abs(at(w - 1, y) - at(0, y));
  for (let x = 0; x < w; x++) seam += Math.abs(at(x, h - 1) - at(x, 0));
  seam /= w + h;
  // Every fourth row and column is plenty for the inside's typical step.
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w - 1; x++) { inner += Math.abs(at(x + 1, y) - at(x, y)); innerN++; }
  for (let x = 0; x < w; x += 4) for (let y = 0; y < h - 1; y++) { inner += Math.abs(at(x, y + 1) - at(x, y)); innerN++; }
  inner /= Math.max(1, innerN);
  // +2 so a nearly flat texture (both near 0) is not judged by noise.
  return (seam + 2) / (inner + 2);
}

/** Seam scores above this show a seam (checked on generated textures: tiled ones score 0.9-1.3, others 2-6). */
export const SEAM_LIMIT = 1.6;

/** A box blur that wraps around the edges (two passes of a running sum), so a tiling input stays tiling. */
export function wrapBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  const mod = (v: number, m: number) => ((v % m) + m) % m;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[y * w + mod(k, w)]!;
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / n;
      sum += src[y * w + mod(x + r + 1, w)]! - src[y * w + mod(x - r, w)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[mod(k, h) * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      sum += tmp[mod(y + r + 1, h) * w + x]! - tmp[mod(y - r, h) * w + x]!;
    }
  }
  return out;
}

/** The maps worked out from an albedo, as PNG files. */
export interface DerivedMaps {
  normal: Uint8Array;
  roughness: Uint8Array;
  ao: Uint8Array;
  height: Uint8Array;
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * The normal, roughness, AO and height maps of an albedo (every filter wraps, so they tile with it):
 * - height: the albedo's lightness, softened and stretched to the full range (light is high, dark crevices low);
 * - normal: Sobel slopes of the height, OpenGL style (green up), which Unity and Blender read;
 * - roughness: dark crevices rougher, light tops a little smoother, around 0.6 (a matte starting point);
 * - AO: how far each pixel lies below its surroundings (a wide blur of the height), darkened.
 *
 * @param p - The albedo.
 * @param strength - How steep the normals are (default 2).
 * @returns The maps as PNG files (normal RGB, the others grey).
 */
export function deriveMaps(p: Picture, strength = 2): DerivedMaps {
  const { w, h } = p;
  const soft = wrapBlur(luminance(p), w, h, Math.max(1, Math.round(w / 512)));
  let lo = 255;
  let hi = 0;
  for (const v of soft) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(1, hi - lo);
  const height = new Float32Array(w * h);
  for (let i = 0; i < height.length; i++) height[i] = ((soft[i]! - lo) / span) * 255;
  const at = (x: number, y: number) => height[((y + h) % h) * w + ((x + w) % w)]! / 255;
  const normal = new Uint8Array(w * h * 3);
  const rough = new Uint8Array(w * h);
  const heightPx = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const dy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      // Image rows go down and texture V goes up: a height rising down the picture tilts the normal up (+green).
      const nx = -dx * strength;
      const ny = dy * strength;
      const len = Math.hypot(nx, ny, 1);
      const i = y * w + x;
      normal[i * 3] = clamp8((nx / len) * 127.5 + 127.5);
      normal[i * 3 + 1] = clamp8((ny / len) * 127.5 + 127.5);
      normal[i * 3 + 2] = clamp8((1 / len) * 127.5 + 127.5);
      rough[i] = clamp8(0.6 * 255 + 0.35 * (128 - height[i]!));
      heightPx[i] = clamp8(height[i]!);
    }
  }
  const around = wrapBlur(height, w, h, Math.max(4, Math.round(w / 64)));
  const ao = new Uint8Array(w * h);
  for (let i = 0; i < ao.length; i++) ao[i] = clamp8(255 - 2.5 * Math.max(0, around[i]! - height[i]!));
  return { normal: encodePng(w, h, 3, normal), roughness: encodePng(w, h, 1, rough), ao: encodePng(w, h, 1, ao), height: encodePng(w, h, 1, heightPx) };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of PNG chunks. */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Writes an 8-bit PNG (no filter per row; zlib does the work).
 *
 * @param w - Width; `h` height.
 * @param ch - 1 (grey), 3 (RGB) or 4 (RGBA).
 * @param data - The pixels, row by row.
 * @returns The PNG file.
 */
export function encodePng(w: number, h: number, ch: 1 | 3 | 4, data: Uint8Array): Uint8Array {
  const row = w * ch;
  const raw = Buffer.alloc((row + 1) * h);
  for (let y = 0; y < h; y++) raw.set(data.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
  const chunk = (type: string, body: Uint8Array) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    out.set(body, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = ch === 1 ? 0 : ch === 3 ? 2 : 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

/**
 * A material's name from the request's first words ("weathered red brick wall" → "Weathered Red Brick").
 *
 * @param prompt - The request.
 * @returns At most three words, letters and digits only; "Texture" when there are none.
 */
export function materialName(prompt: string): string {
  const words = prompt.replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter((x) => x.length > 1 && !/^(a|an|the|of|with|and|seamless|tileable|texture|pbr|material)$/i.test(x));
  return words.slice(0, 3).map((x) => x[0]!.toUpperCase() + x.slice(1).toLowerCase()).join(" ") || "Texture";
}
