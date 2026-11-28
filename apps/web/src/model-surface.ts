/**
 * Pure helpers of the 3D surface (ModelPanel.tsx): which files and tool results open it, whether the live viewer or a
 * static poster is used on this machine, the parts and materials read from a model file without a GPU, the light
 * presets, and the "Ask about this part" message. No React and no three.js, so they run in `node:test`.
 */

/** The chat files the 3D surface opens. */
export const MODEL_FILES = /\.(glb|gltf|fbx|obj)$/i;

/**
 * The 3D file a tool step made (`make_3d`: "Made the 3D model <path> (GLB, …)").
 *
 * @param tool - The tool's name; `ok` and `output` its result.
 * @returns The file's path inside the chat's folder (with `/`), or undefined.
 */
export function modelFromResult(tool: string, ok: boolean, output: string): string | undefined {
  if (!ok || tool !== "make_3d") return undefined;
  const m = /Made the 3D model (.+?\.(?:glb|gltf|fbx|obj))(?=[\s(,;]|\.?(?:\s|$))/i.exec(output);
  return m?.[1]?.trim().split("\\").join("/");
}

/** What the browser can draw: a real GPU context, a software one (slow), or none. */
export type GpuClass = "gpu" | "software" | "none";

/**
 * Classifies the WebGL2 context of this machine.
 *
 * @param hasWebGL2 - A WebGL2 context could be made.
 * @param renderer - The unmasked renderer name, when the browser gives it.
 * @returns "gpu", "software" (SwiftShader, llvmpipe, a "Basic Render" adapter: too slow to turn a big model) or "none".
 */
export function classifyGpu(hasWebGL2: boolean, renderer = ""): GpuClass {
  if (!hasWebGL2) return "none";
  return /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(renderer) ? "software" : "gpu";
}

/** The user's choice in the panel: let KesherAI decide, always live, or always the static poster. */
export type ViewPref = "auto" | "live" | "static";

/**
 * Which view to show: the live viewer (turntable, orbit) or the static poster.
 *
 * @param gpu - What this machine draws ({@link classifyGpu}).
 * @param pref - The user's choice. "live" on a machine with no WebGL2 is still the poster: nothing can draw it.
 * @returns "live" or "poster".
 */
export function chooseView(gpu: GpuClass, pref: ViewPref = "auto"): "live" | "poster" {
  if (gpu === "none" || pref === "static") return "poster";
  if (pref === "live") return "live";
  return gpu === "gpu" ? "live" : "poster";
}

let detected: GpuClass | undefined;

/**
 * Detects the GPU class once per page (a probe canvas, then released).
 *
 * @param make - Makes a canvas; the default is the page's own (a test passes a fake).
 * @returns The class, the same on every later call.
 */
export function detectGpu(make: () => { getContext(id: string): unknown } = () => document.createElement("canvas")): GpuClass {
  if (detected) return detected;
  try {
    const gl = make().getContext("webgl2") as (WebGL2RenderingContext | null);
    let renderer = "";
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && ext) renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    detected = classifyGpu(!!gl, renderer);
  } catch {
    detected = "none";
  }
  return detected;
}

/** Forgets the detection (tests only). */
export function resetGpuDetection(): void {
  detected = undefined;
}

/** One material of a model. */
export interface ModelMaterial { name: string; color?: string }

/** What a model file holds, read without drawing it. */
export interface ModelParts { meshes: string[]; materials: ModelMaterial[] }

const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, "0");

/**
 * The meshes and materials of a glTF document (the JSON of a .gltf, or of a .glb's first chunk).
 *
 * @param json - The parsed JSON.
 * @returns Mesh names (a nameless mesh is "mesh N") and materials (name and base colour).
 */
export function partsFromGltf(json: unknown): ModelParts {
  const j = (json ?? {}) as { meshes?: Array<{ name?: unknown }>; materials?: Array<{ name?: unknown; pbrMetallicRoughness?: { baseColorFactor?: number[] } }> };
  const meshes = (j.meshes ?? []).slice(0, 500).map((m, i) => (typeof m.name === "string" && m.name ? m.name : `mesh ${i}`));
  const materials = (j.materials ?? []).slice(0, 200).map((m, i) => {
    const c = m.pbrMetallicRoughness?.baseColorFactor;
    const color = c && c.length >= 3 ? `#${hex(c[0]!)}${hex(c[1]!)}${hex(c[2]!)}` : undefined;
    return { name: typeof m.name === "string" && m.name ? m.name : `material ${i}`, ...(color ? { color } : {}) };
  });
  return { meshes, materials };
}

/**
 * Reads the JSON chunk of a .glb (12-byte header, then chunks of length, type, data).
 *
 * @param buf - The file's bytes.
 * @returns The parts, or undefined when it is not a glb.
 */
export function partsFromGlb(buf: ArrayBuffer): ModelParts | undefined {
  if (buf.byteLength < 20) return undefined;
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== 0x46546c67) return undefined; // "glTF"
  const len = v.getUint32(12, true);
  if (v.getUint32(16, true) !== 0x4e4f534a || 20 + len > buf.byteLength) return undefined; // "JSON"
  try {
    return partsFromGltf(JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len))));
  } catch {
    return undefined;
  }
}

/**
 * The objects and materials an .obj names (`o` / `g` lines and `usemtl`).
 *
 * @param text - The file's text.
 */
export function partsFromObj(text: string): ModelParts {
  const meshes: string[] = [];
  const mats: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(o|g|usemtl)\s+(.+)$/.exec(line);
    if (!m) continue;
    const name = m[2]!.trim();
    const into = m[1] === "usemtl" ? mats : meshes;
    if (!into.includes(name) && into.length < 500) into.push(name);
  }
  return { meshes, materials: mats.map((name) => ({ name })) };
}

/** The light presets of the viewer: sky and ground colours, and the sun's strength and place. */
export const LIGHT_PRESETS = {
  studio: { he: "סטודיו", en: "Studio", sky: 0xffffff, ground: 0x444466, hemi: 2.2, sun: 2, at: [3, 5, 4] },
  soft: { he: "רך", en: "Soft", sky: 0xffffff, ground: 0x888899, hemi: 3.2, sun: 0.6, at: [0, 6, 2] },
  sun: { he: "שמש", en: "Sun", sky: 0xbfd8ff, ground: 0x4a4030, hemi: 1.1, sun: 3.6, at: [6, 4, -2] },
  dark: { he: "חשוך", en: "Dark", sky: 0x445566, ground: 0x101018, hemi: 0.6, sun: 1.4, at: [-4, 3, 4] },
} as const;

/** A light preset's key. */
export type LightId = keyof typeof LIGHT_PRESETS;

/**
 * The chat message for "Ask about this part": names the file, the picked part and (when there is one) its material.
 *
 * @param p - `path`: the model file; `part`: the picked mesh's name; `material`: its material; `instruction`: the
 *   question; `he`: whether to write the frame in Hebrew.
 * @returns The message to send to the chat.
 */
export function partAskMessage(p: { path: string; part: string; material?: string; instruction: string; he: boolean }): string {
  const part = p.part.slice(0, 200);
  const mat = p.material ? p.material.slice(0, 200) : "";
  const ask = p.instruction.trim();
  return p.he
    ? `במודל התלת ממד ${p.path}, על החלק "${part}"${mat ? ` (חומר "${mat}")` : ""}:\n\n${ask}`
    : `In the 3D model ${p.path}, about the part "${part}"${mat ? ` (material "${mat}")` : ""}:\n\n${ask}`;
}
