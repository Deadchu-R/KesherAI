import type { HelperKind } from "@kesher/shared";

/**
 * Which model a helper runs on (docs/RESEARCH_LOG.md, "Helper agents in the chat", plan step 2). Chosen once when
 * the helper starts and kept while it runs (switching per step loses the cache and the task state).
 *
 * On a computer with one llama.cpp model loaded:
 * - lookup: a small installed model when it fits beside the chat's model; never a swap (a lookup is short, a load
 *   takes up to a minute), so otherwise it runs on the loaded model and says so.
 * - research: the chat's model (already loaded, no swap).
 * - build: a stronger installed code model when the card can hold it; beside the chat's model when both fit, else
 *   one swap in and one back after (shown on screen). Otherwise the chat's model.
 * - A cloud model only when the user chose one (it costs money and sees the task).
 */

/** A chat model file on this computer (the built-in engine's GGUFs). */
export interface LocalModel {
  path: string;
  /** The file's name, e.g. `Qwen3-4B-Q4_K_M.gguf`. */
  name: string;
  sizeGiB: number;
}

/** What the choice depends on. */
export interface HelperModelInput {
  kind: HelperKind;
  /** The setting or the agent's own: `auto`, `inherit`, `small`, `strong`, or a model id. */
  choice: string;
  /** The largest graphics card's memory (GiB); 0 = none. */
  vramGiB: number;
  /** The chat's model, with its file when it is the engine's loaded GGUF. */
  lead: { modelId: string; path?: string; sizeGiB?: number };
  /** Chat model files on this computer. */
  local: LocalModel[];
  /** Cloud model ids the user has a key for. */
  cloud: string[];
}

/** Two short lines, Hebrew and English. */
export interface Why {
  he: string;
  en: string;
}

/** The choice: the chat's model, a file loaded beside it or instead of it (a swap), or another model id. */
export type HelperModelPick =
  | { how: "inherit"; modelId: string; why: Why; /** It wanted another model but would not swap for it. */ noSwap?: string }
  | { how: "beside" | "swap"; path: string; name: string; sizeGiB: number; why: Why }
  | { how: "id"; modelId: string; cloud: boolean; why: Why };

/** Memory a loaded model takes besides its file (context, buffers), GiB. */
const OVERHEAD_GIB = 1.5;
/** Files that are not chat models. */
const NOT_CHAT = /embed|rerank|whisper|mmproj|tts|vae|clip|lora/i;
/** Code models (a build helper prefers them). */
const CODE_MODEL = /coder|code|devstral|codestral|starcoder/i;

/** @returns The model's short name for the screen: `Qwen3-4B-Q4_K_M.gguf` → `Qwen3-4B`. */
export function shortModelName(idOrFile: string): string {
  const base = idOrFile.split(/[\\/]/).pop() ?? idOrFile;
  return base.replace(/\.gguf$/i, "").replace(/[-_.](?:UD[-_])?(?:I?Q\d[\w]*|F16|BF16|F32)$/i, "") || base;
}

/** @returns The engine's model id for a file (as routes/engine.ts names it). */
export function engineIdOf(file: string): string {
  return `llamacpp/${(file.split(/[\\/]/).pop() ?? file).replace(/\.gguf$/i, "").replace(/[\s/]+/g, "-")}`;
}

/** @returns About how long a file takes to load, in seconds (measured on the PC: 17 GB in about 40 s). */
export function loadSeconds(sizeGiB: number): number {
  return Math.max(5, Math.round(sizeGiB * 2.4));
}

const fitsAlone = (size: number, vram: number) => vram > 0 && size + OVERHEAD_GIB <= vram;
const fitsBeside = (size: number, lead: number, vram: number) => vram > 0 && size + lead + 2 * OVERHEAD_GIB <= vram;
const gb = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)} GB`;

/**
 * Chooses a helper's model.
 *
 * @param i - The helper's type, the setting, the card, the chat's model, the files on this computer and cloud keys.
 * @returns The choice and a short reason for the screen.
 */
export function pickHelperModel(i: HelperModelInput): HelperModelPick {
  const p = pick(i);
  // No chat model yet (a new install): "same as the chat", without an empty name.
  if (!i.lead.modelId) p.why = { he: p.why.he.replace(/ \(\)/g, ""), en: p.why.en.replace(/ \(\)/g, "") };
  return p;
}

function pick(i: HelperModelInput): HelperModelPick {
  const leadName = shortModelName(i.lead.modelId);
  const inherit = (why: Why, noSwap?: string): HelperModelPick => ({ how: "inherit", modelId: i.lead.modelId, why, ...(noSwap ? { noSwap } : {}) });
  const same: Why = { he: `כמו הצ׳אט (${leadName}) · כבר טעון, בלי החלפה`, en: `same as the chat (${leadName}) · already loaded, no swap` };
  const choice = i.choice.trim() || "auto";
  if (choice === "inherit") return inherit(same);
  const local = i.local.filter((m) => !NOT_CHAT.test(m.name) && m.path !== i.lead.path);
  const leadLocal = !!i.lead.path;
  const leadSize = i.lead.sizeGiB ?? 0;
  const mayLoad = (m: LocalModel, kindWhy: Why): HelperModelPick => {
    if (fitsBeside(m.sizeGiB, leadSize, i.vramGiB))
      return { how: "beside", path: m.path, name: shortModelName(m.name), sizeGiB: m.sizeGiB, why: { he: `${kindWhy.he} · ${gb(m.sizeGiB)}, נכנס ליד המודל הראשי, בלי החלפה`, en: `${kindWhy.en} · ${gb(m.sizeGiB)}, fits beside the chat's model, no swap` } };
    if (i.kind === "build" && fitsAlone(m.sizeGiB, i.vramGiB))
      return { how: "swap", path: m.path, name: shortModelName(m.name), sizeGiB: m.sizeGiB, why: { he: `${kindWhy.he} · לא נכנס יחד עם הראשי: מחליף פעם אחת לעבודה ומחזיר בסוף (~${loadSeconds(m.sizeGiB)} שנ׳ לכל כיוון)`, en: `${kindWhy.en} · does not fit with the chat's model: swaps once for the job and back at the end (~${loadSeconds(m.sizeGiB)} s each way)` } };
    const name = shortModelName(m.name);
    return inherit({ he: `רץ על ${leadName}, בלי החלפה (${name} לא נכנס ליד הראשי)`, en: `runs on ${leadName}, no swap (${name} does not fit beside the chat's model)` }, name);
  };
  // A model by id: the engine's own files are loaded like the tiers; any other id runs as it is (a cloud model, Ollama…).
  if (!["auto", "small", "strong"].includes(choice)) {
    if (choice === i.lead.modelId) return inherit(same);
    const file = local.find((m) => engineIdOf(m.name) === choice || m.path === choice);
    if (file) return mayLoad(file, { he: `נבחר: ${shortModelName(file.name)}`, en: `chosen: ${shortModelName(file.name)}` });
    const cloud = i.cloud.includes(choice);
    return { how: "id", modelId: choice, cloud, why: cloud ? { he: `☁ ${shortModelName(choice)} בענן (נבחר בהגדרות)`, en: `☁ ${shortModelName(choice)} in the cloud (chosen in Settings)` } : { he: `נבחר: ${shortModelName(choice)}`, en: `chosen: ${shortModelName(choice)}` } };
  }
  // The tiers choose among the engine's files, so they need the chat to be on the engine.
  if (!leadLocal) return inherit({ he: `כמו הצ׳אט (${leadName})`, en: `same as the chat (${leadName})` });
  const tier = choice === "auto" ? (i.kind === "lookup" ? "small" : i.kind === "build" ? "strong" : "inherit") : choice;
  if (tier === "inherit") return inherit(same);
  if (tier === "small") {
    const smallMax = Math.max(3, i.vramGiB * 0.25);
    if (leadSize && leadSize <= smallMax) return inherit({ he: `כמו הצ׳אט (${leadName}) · המודל הראשי כבר קטן`, en: `same as the chat (${leadName}) · the chat's model is already small` });
    if (!i.vramGiB) return inherit({ he: `כמו הצ׳אט (${leadName}) · אין כרטיס מסך לשני מודלים`, en: `same as the chat (${leadName}) · no graphics card for two models` });
    const small = local.filter((m) => m.sizeGiB <= smallMax).sort((a, b) => a.sizeGiB - b.sizeGiB)[0];
    if (!small) return inherit({ he: `כמו הצ׳אט (${leadName}) · אין מודל קטן מותקן`, en: `same as the chat (${leadName}) · no small model installed` });
    return mayLoad(small, { he: `→ ${shortModelName(small.name)}`, en: `→ ${shortModelName(small.name)}` });
  }
  // strong: the largest file that fits on the card alone and is larger than the chat's; a build prefers code models.
  const bigger = local.filter((m) => m.sizeGiB > leadSize && fitsAlone(m.sizeGiB, i.vramGiB)).sort((a, b) => b.sizeGiB - a.sizeGiB);
  const strong = (i.kind === "build" ? bigger.find((m) => CODE_MODEL.test(m.name)) : undefined) ?? (choice === "strong" ? bigger[0] : undefined);
  if (!strong) return inherit({ he: `כמו הצ׳אט (${leadName}) · אין מודל חזק יותר שנכנס בכרטיס`, en: `same as the chat (${leadName}) · no stronger model that fits the card` });
  return mayLoad(strong, { he: `→ ${shortModelName(strong.name)}`, en: `→ ${shortModelName(strong.name)}` });
}

/**
 * How many local helpers run at once: 1 on a card with 8 GB or less (or none), else 2; the setting may change it
 * (1 to 4). Cloud and outside helpers do not take the card's room; they are capped at 4 apart.
 *
 * @param vramGiB - The largest card's memory.
 * @param setting - Settings > Helpers > at once, when set.
 */
export function helperLimit(vramGiB: number, setting?: number): number {
  if (setting && Number.isFinite(setting)) return Math.min(4, Math.max(1, Math.round(setting)));
  return vramGiB > 8 ? 2 : 1;
}

/**
 * The swap rule: only a build helper may swap the loaded model, once.
 *
 * @param kind - The helper's type.
 */
export function maySwap(kind: HelperKind): boolean {
  return kind === "build";
}
