/**
 * LoRAs from CivitAI (audit F5): search, the trigger words each LoRA was trained with, and a safe download (the
 * file's address is looked up again on CivitAI by version id, never taken from the page, and checked by SHA-256).
 * Like Locally Uncensored's LoRA browser and ComfyUI-Lora-Auto-Trigger-Words.
 */

export const CIVITAI = "https://civitai.com";

/** One LoRA in the search results. */
export interface CivitaiLora {
  modelId: number;
  versionId: number;
  name: string;
  version: string;
  creator?: string;
  baseModel?: string;
  triggers: string[];
  fileName: string;
  sizeBytes: number;
  sha256?: string;
  image?: string;
  downloads?: number;
  nsfw: boolean;
}

type Version = {
  id?: number;
  name?: string;
  baseModel?: string;
  trainedWords?: unknown;
  files?: Array<{ name?: string; sizeKB?: number; primary?: boolean; type?: string; hashes?: { SHA256?: string }; downloadUrl?: string }>;
  images?: Array<{ url?: string; nsfwLevel?: number; nsfw?: unknown; type?: string }>;
  stats?: { downloadCount?: number };
};

/**
 * The file a version downloads: the primary .safetensors model file.
 * @param v - A model version from CivitAI.
 */
export function pickFile(v: Version): NonNullable<Version["files"]>[number] | undefined {
  const files = (v.files ?? []).filter((f) => /\.safetensors$/i.test(f.name ?? "") && (f.type ?? "Model") === "Model");
  return files.find((f) => f.primary) ?? files[0];
}

/**
 * A plain file name for a LoRA: letters, digits, dot, dash, underscore; ends in .safetensors.
 * @param name - The name CivitAI gives.
 */
export function safeLoraFile(name: string): string {
  const base = name.replace(/\.safetensors$/i, "").replace(/[^\w.-]+/g, "_").replace(/^[._]+/, "").slice(0, 100) || "lora";
  return `${base}.safetensors`;
}

/**
 * The trigger words, cleaned: short, no duplicates, at most 12.
 * @param words - `trainedWords` from CivitAI.
 */
export function cleanTriggers(words: unknown): string[] {
  const out: string[] = [];
  for (const w of Array.isArray(words) ? words : []) {
    for (const part of String(w).split(/,\s*/)) {
      const t = part.trim().slice(0, 60);
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out.slice(0, 12);
}

/**
 * Turns CivitAI's model list into LoRA cards (the newest version of each).
 * @param items - `items` from `/api/v1/models`.
 */
export function toLoras(items: unknown): CivitaiLora[] {
  const out: CivitaiLora[] = [];
  for (const m of Array.isArray(items) ? (items as Array<{ id?: number; name?: string; nsfw?: boolean; creator?: { username?: string }; modelVersions?: Version[] }>) : []) {
    const v = m.modelVersions?.[0];
    const f = v ? pickFile(v) : undefined;
    if (!m.id || !v?.id || !f?.name) continue;
    // A preview picture that is safe to show (an image, not a video; low nsfw level).
    const pic = (v.images ?? []).find((i) => i.url && (i.type ?? "image") === "image" && (i.nsfwLevel ?? 1) <= 1);
    out.push({
      modelId: m.id,
      versionId: v.id,
      name: String(m.name ?? "").slice(0, 120),
      version: String(v.name ?? "").slice(0, 60),
      ...(m.creator?.username ? { creator: m.creator.username.slice(0, 60) } : {}),
      ...(v.baseModel ? { baseModel: v.baseModel.slice(0, 40) } : {}),
      triggers: cleanTriggers(v.trainedWords),
      fileName: safeLoraFile(f.name),
      sizeBytes: Math.round((f.sizeKB ?? 0) * 1024),
      ...(f.hashes?.SHA256 ? { sha256: f.hashes.SHA256.toLowerCase() } : {}),
      ...(pic?.url?.startsWith("https://image.civitai.com/") ? { image: pic.url } : {}),
      ...(v.stats?.downloadCount !== undefined ? { downloads: v.stats.downloadCount } : {}),
      nsfw: m.nsfw === true,
    });
  }
  return out;
}

/**
 * Searches CivitAI's LoRAs.
 * @param query - Words to search for.
 * @param opts.nsfw - Include adult models (off by default).
 * @param opts.baseModel - Only for this base model (e.g. "SDXL 1.0", "Flux.1 D").
 * @param opts.token - The user's CivitAI key (optional).
 * @param signal - Stops it.
 */
export async function searchLoras(query: string, opts: { nsfw?: boolean; baseModel?: string; token?: string }, signal: AbortSignal): Promise<CivitaiLora[]> {
  const q = new URLSearchParams({ types: "LORA", limit: "24", sort: "Most Downloaded", nsfw: opts.nsfw ? "true" : "false" });
  if (query.trim()) q.set("query", query.trim().slice(0, 100));
  if (opts.baseModel) q.set("baseModels", opts.baseModel);
  const res = await fetch(`${CIVITAI}/api/v1/models?${q}`, { headers: { "user-agent": "KesherAI", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  if (!res.ok) throw new Error(`CivitAI answered ${res.status}.`);
  const all = toLoras(((await res.json()) as { items?: unknown }).items);
  return opts.nsfw ? all : all.filter((l) => !l.nsfw);
}

/**
 * One version, looked up again for a download (its file address, size and SHA-256 come from CivitAI, not the page).
 * @param versionId - The version's id.
 * @param token - The user's CivitAI key (optional).
 * @param signal - Stops it.
 */
export async function versionForDownload(versionId: number, token: string | undefined, signal: AbortSignal): Promise<{ url: string; fileName: string; sizeBytes: number; sha256?: string; triggers: string[]; baseModel?: string; name: string; modelId?: number }> {
  const res = await fetch(`${CIVITAI}/api/v1/model-versions/${versionId}`, { headers: { "user-agent": "KesherAI", ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  if (!res.ok) throw new Error(`CivitAI answered ${res.status}.`);
  const v = (await res.json()) as Version & { modelId?: number; model?: { name?: string; type?: string } };
  if (v.model?.type && v.model.type !== "LORA" && v.model.type !== "LoCon") throw new Error("That is not a LoRA.");
  const f = pickFile(v);
  if (!f?.downloadUrl || !f.name) throw new Error("This LoRA has no file to download.");
  const url = new URL(f.downloadUrl);
  if (url.protocol !== "https:" || url.hostname !== "civitai.com") throw new Error("The download is not on civitai.com.");
  return {
    url: url.href,
    fileName: safeLoraFile(f.name),
    sizeBytes: Math.round((f.sizeKB ?? 0) * 1024),
    ...(f.hashes?.SHA256 ? { sha256: f.hashes.SHA256.toLowerCase() } : {}),
    triggers: cleanTriggers(v.trainedWords),
    ...(v.baseModel ? { baseModel: v.baseModel } : {}),
    name: String(v.model?.name ?? v.name ?? "").slice(0, 120),
    ...(v.modelId ? { modelId: v.modelId } : {}),
  };
}
