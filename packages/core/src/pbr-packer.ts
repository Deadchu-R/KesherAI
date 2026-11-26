/**
 * PBR map packing for game engines (GE-23 Muse-parity asset pipelines, slice 1/3):
 * converts raw normal, roughness, AO and height maps into the packed textures that
 * Unity URP/HDRP Lit shaders and Unreal ORM slot expect. The normal map can be
 * flipped between OpenGL (green-up, Unity/Blender default) and DirectX (green-down,
 * Unreal/Substance default) without re-baking. Pure functions, no GPU, no deps.
 */

import { encodePng, readPicture } from "./pbr-flow.js";

/** Which way the normal map Y axis points. OpenGL = green up (Unity, Blender); DirectX = green down (Unreal, Substance). */
export type NormalConvention = "opengl" | "directx";

/** Inputs to packPbrMaps: each field is an optional PNG buffer. At least one must be present. */
export interface PbrPackInput {
  /** Albedo / base color (RGB). Used only as a size reference when other maps are missing. */
  albedo?: Uint8Array;
  /** Tangent-space normal map (RGB). Flipped to the chosen convention when needed. */
  normal?: Uint8Array;
  /** Roughness (grayscale). Packed into G of ORM for Unreal, or kept separate for Unity. */
  roughness?: Uint8Array;
  /** Ambient occlusion (grayscale). Packed into R of ORM for Unreal. */
  ao?: Uint8Array;
  /** Metallic (grayscale). Packed into B of ORM for Unreal. */
  metallic?: Uint8Array;
  /** Height / displacement (grayscale). Kept separate; not packed into ORM. */
  height?: Uint8Array;
}

/** What packPbrMaps returns: PNG buffers ready to save or hand to unity_create_pbr_material. */
export interface PbrPackOutput {
  /** Normal map in the requested convention (PNG, RGB). Undefined when no normal was given. */
  normal?: Uint8Array;
  /** ORM pack for Unreal (PNG, RGB): R=AO, G=Roughness, B=Metallic. Undefined when none of the three were given. */
  orm?: Uint8Array;
  /** Roughness map (PNG, grayscale). Undefined when no roughness was given. */
  roughness?: Uint8Array;
  /** AO map (PNG, grayscale). Undefined when no AO was given. */
  ao?: Uint8Array;
  /** Metallic map (PNG, grayscale). Undefined when no metallic was given. */
  metallic?: Uint8Array;
  /** Height map (PNG, grayscale). Undefined when no height was given. */
  height?: Uint8Array;
  /** Width of every output map (all inputs are stretched to this). */
  w: number;
  /** Height of every output map. */
  h: number;
  /** The convention the normal map was written in. */
  convention: NormalConvention;
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * Reads a PNG into a Float32Array of [0..1] values, one per channel per pixel, resized to (w, h) with nearest-neighbour.
 * Returns undefined when the input is undefined. The resize keeps every output map the same size so they tile together.
 */
function readAndResize(png: Uint8Array | undefined, w: number, h: number): Float32Array | undefined {
  if (!png) return undefined;
  const p = readPicture(png);
  if (!p) return undefined;
  const out = new Float32Array(w * h * p.ch);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(p.h - 1, Math.round((y / h) * p.h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(p.w - 1, Math.round((x / w) * p.w));
      const si = (sy * p.w + sx) * p.ch;
      const di = (y * w + x) * p.ch;
      for (let c = 0; c < p.ch; c++) out[di + c] = p.data[si + c]! / 255;
    }
  }
  return out;
}

/**
 * Flips a tangent-space normal map between OpenGL and DirectX conventions by inverting the green channel.
 * The input and output are [0..1] Float32Arrays with 3 channels per pixel. When the convention already matches,
 * the array is returned unchanged (no copy). A flat normal (0.5, 0.5, 1.0) stays flat under either flip.
 */
export function flipNormalY(normal: Float32Array, from: NormalConvention, to: NormalConvention): Float32Array {
  if (from === to) return normal;
  const out = new Float32Array(normal.length);
  out.set(normal);
  for (let i = 1; i < out.length; i += 3) out[i] = 1 - out[i]!;
  return out;
}

/**
 * Packs PBR maps for a game engine from raw PNG inputs. All outputs share the albedo size (or the first map size
 * when no albedo is given). The normal map is converted to the requested convention; roughness, AO and metallic are
 * packed into a single ORM texture for Unreal when at least one of them is present, and also returned separately for
 * Unity URP/HDRP Lit shaders. Height is never packed (it lives in its own slot).
 *
 * @param input Raw PNG buffers. At least one must be non-empty.
 * @param convention Target normal convention ("opengl" for Unity/Blender, "directx" for Unreal/Substance).
 * @returns PNG buffers sized to the albedo, plus the chosen convention name. Throws when no input is given.
 */
export function packPbrMaps(input: PbrPackInput, convention: NormalConvention = "opengl"): PbrPackOutput {
  const sizes: { w: number; h: number }[] = [];
  if (input.albedo) { const p = readPicture(input.albedo); if (p) sizes.push({ w: p.w, h: p.h }); }
  if (input.normal) { const p = readPicture(input.normal); if (p) sizes.push({ w: p.w, h: p.h }); }
  if (input.roughness) { const p = readPicture(input.roughness); if (p) sizes.push({ w: p.w, h: p.h }); }
  if (input.ao) { const p = readPicture(input.ao); if (p) sizes.push({ w: p.w, h: p.h }); }
  if (input.metallic) { const p = readPicture(input.metallic); if (p) sizes.push({ w: p.w, h: p.h }); }
  if (input.height) { const p = readPicture(input.height); if (p) sizes.push({ w: p.w, h: p.h }); }
  if (sizes.length === 0) throw new Error("packPbrMaps: at least one map must be provided");
  const { w, h } = sizes[0]!;

  const normF = readAndResize(input.normal, w, h);
  const roughF = readAndResize(input.roughness, w, h);
  const aoF = readAndResize(input.ao, w, h);
  const metF = readAndResize(input.metallic, w, h);
  const heightF = readAndResize(input.height, w, h);

  const out: PbrPackOutput = { w, h, convention };

  if (normF) {
    // deriveMaps produces OpenGL normals; flip when DirectX is requested.
    const final = flipNormalY(normF, "opengl", convention);
    const bytes = new Uint8Array(w * h * 3);
    for (let i = 0; i < final.length; i++) bytes[i] = clamp8(final[i]! * 255);
    out.normal = encodePng(w, h, 3, bytes);
  }

  if (roughF || aoF || metF) {
    const orm = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      orm[i * 3] = clamp8((aoF ? aoF[i]! : 1) * 255);
      orm[i * 3 + 1] = clamp8((roughF ? roughF[i]! : 0.5) * 255);
      orm[i * 3 + 2] = clamp8((metF ? metF[i]! : 0) * 255);
    }
    out.orm = encodePng(w, h, 3, orm);
  }

  if (roughF) {
    const bytes = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bytes[i] = clamp8(roughF[i]! * 255);
    out.roughness = encodePng(w, h, 1, bytes);
  }
  if (aoF) {
    const bytes = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bytes[i] = clamp8(aoF[i]! * 255);
    out.ao = encodePng(w, h, 1, bytes);
  }
  if (metF) {
    const bytes = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bytes[i] = clamp8(metF[i]! * 255);
    out.metallic = encodePng(w, h, 1, bytes);
  }
  if (heightF) {
    const bytes = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bytes[i] = clamp8(heightF[i]! * 255);
    out.height = encodePng(w, h, 1, bytes);
  }

  return out;
}
