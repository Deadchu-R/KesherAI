/**
 * "This tool works better with another model": every model (the loaded one, the ones on the computer, the "Start
 * here" list) gets a score from 0 to 100 for one tool on this computer, from three parts added together:
 *
 * - quality (up to 40): the model's size in parameters (log scale: 4B ≈ 13, 12B ≈ 24, 30B ≈ 33, 70B+ = 40);
 * - fit for the tool (up to 35): Hebrew (Dicta's models first), tools and file editing (coding models first),
 *   a long context for long chat reports;
 * - this computer (up to 25): the estimated writing speed (the Models page's estimate; 40 tokens a second or more is
 *   full marks); a model that does not fit in memory scores 0 and is never offered.
 *
 * A line is shown only when another model scores at least 8 more than the loaded one. KesherAI never switches by
 * itself; the page shows the line with "Switch" and "Keep".
 *
 * Research: docs/RESEARCH_LOG.md "Tools suggest a better model" (AnythingLLM's calculated router rules, Msty's
 * Matchmaker, Cursor users asking for a warning instead of an error).
 */
import { RECOMMENDED_MODELS } from "./recommended.js";

/** A tool that can suggest a model. */
export type ModelTool = "study" | "chat-report" | "code";

/** What a tool needs from the chat model. */
export interface ToolNeed {
  /** Hebrew text (prefers Dicta's Hebrew models). */
  hebrew?: boolean;
  /** Tokens each chat should hold at least. */
  minContext?: number;
  /** Good tool calling and file editing. */
  tools?: boolean;
  /** The tool loads a fitting model on the computer by itself (Study's course model "auto"): only a download is suggested. */
  usesLocalBySelf?: boolean;
}

/**
 * What a tool needs.
 *
 * @param tool - The tool.
 * @param hebrew - Whether the interface (or the text) is Hebrew.
 * @returns Its needs.
 */
export function toolNeed(tool: ModelTool, hebrew: boolean): ToolNeed {
  if (tool === "study") return { hebrew, minContext: 16_384, usesLocalBySelf: true };
  if (tool === "chat-report") return { hebrew, minContext: 65_536 };
  return { tools: true, minContext: 32_768 };
}

/** A model file on the computer. */
export interface LocalModel {
  name: string;
  path: string;
  /** Bytes. */
  size: number;
}

/** A model's score for one tool on this computer, with its three parts. */
export interface ModelScore {
  total: number;
  quality: number;
  fit: number;
  speed: number;
  /** Estimated tokens a second here (0: does not fit). */
  tokensPerSecond: number;
  /** All of it on the graphics card. */
  fitsGpu: boolean;
}

/** One option: a model on the computer to switch to, or a better one to download, with its score. */
export type ModelOption =
  | { kind: "switch"; name: string; path: string; sizeGb: number; score: ModelScore }
  | { kind: "download"; name: string; id: string; sizeGb: number; score: ModelScore };

/** What the tool's line shows: the loaded model's score, up to two better options, and a context warning. */
export interface ModelSuggestion {
  loaded?: { name: string; score: ModelScore };
  options: ModelOption[];
  /** Each chat holds fewer tokens than the tool needs. */
  context?: { have: number; want: number };
}

/** How fast a model of this size writes here (the Models page's estimate), and whether it fits on the card. */
export type SpeedEstimate = (sizeGb: number, activeFraction?: number) => { tokensPerSecond: number; fitsGpu: boolean };

const gb = (bytes: number) => Math.round((bytes / 1e9) * 10) / 10;
const pretty = (name: string) => name.replace(/\.gguf$/i, "").replace(/[-_.]?(Q\d\w*|IQ\d\w*|BF16|F16|mxfp4)$/i, "");
const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const TOOL_IDS = RECOMMENDED_MODELS.filter((r) => r.goodForCode).map((r) => key(r.id));

/**
 * The model's size in billions of parameters: from its name ("31B", "12b", "8x7B", "A3B" for active parts is
 * skipped), else from the file size (about 0.6 GB per billion at 4 bits).
 *
 * @param name - File or model name.
 * @param sizeGb - File size in GB.
 * @returns Billions of parameters.
 */
export function paramsOf(name: string, sizeGb: number): number {
  const moe = /(\d+)x(\d+(?:\.\d+)?)b/i.exec(name);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const all = [...name.matchAll(/(?<![a-z])(\d+(?:\.\d+)?)b(?![a-z])/gi)].filter((m) => !/a$/i.test(name.slice(0, m.index)));
  const n = all.map((m) => Number(m[1])).filter((x) => x >= 0.5 && x <= 1000);
  return n.length ? Math.max(...n) : Math.max(0.5, sizeGb / 0.6);
}

/**
 * The tool-fit part (0–35).
 *
 * @param name - Model or file name.
 * @param need - What the tool needs.
 * @returns Points.
 */
export function toolFit(name: string, need: ToolNeed): number {
  const k = key(name);
  let pts = 20;
  if (need.hebrew) pts = /dicta/.test(k) ? 35 : /gemma|qwen3|aya|command/.test(k) ? 18 : 8;
  else if (need.tools) pts = /coder|devstral|gptoss/.test(k) ? 35 : /gemma4|qwen3[5-9]/.test(k) || TOOL_IDS.some((id) => k.includes(id)) ? 26 : 8;
  // Long chat reports: models built for long contexts (Nemotron hybrids such as DictaLM 3, Qwen3's 256K) keep up.
  if (need.minContext && need.minContext >= 65_536 && /dicta|nemotron|qwen3|gemma4/.test(k)) pts = Math.min(35, pts + 5);
  return pts;
}

/**
 * A model's score for a tool on this computer (see the top of this file).
 *
 * @param name - Model or file name.
 * @param sizeGb - Its size in GB.
 * @param need - What the tool needs.
 * @param speed - This computer's speed estimate.
 * @param activeFraction - Share of the weights used per token (mixture-of-experts models).
 * @returns The score and its parts.
 */
export function scoreModel(name: string, sizeGb: number, need: ToolNeed, speed: SpeedEstimate, activeFraction?: number): ModelScore {
  const est = speed(sizeGb, activeFraction);
  if (est.tokensPerSecond <= 0) return { total: 0, quality: 0, fit: 0, speed: 0, tokensPerSecond: 0, fitsGpu: false };
  const quality = Math.round(Math.min(40, 13 + 17 * Math.log2(paramsOf(name, sizeGb) / 4) / Math.log2(7.5)));
  const fit = toolFit(name, need);
  const fast = Math.round(25 * Math.min(1, est.tokensPerSecond / 40));
  return { total: Math.max(0, quality) + fit + fast, quality: Math.max(0, quality), fit, speed: fast, tokensPerSecond: est.tokensPerSecond, fitsGpu: est.fitsGpu };
}

/**
 * The tool's suggestion, if any: every model is scored ({@link scoreModel}); the best one on the computer is offered
 * when it beats the loaded one by 8 or more, and the best one to download when it beats both by 8 or more.
 *
 * @param need - What the tool needs ({@link toolNeed}).
 * @param loaded - The loaded model's file name, size and each chat's context, if known.
 * @param local - The model files on the computer.
 * @param speed - This computer's speed estimate.
 * @returns The suggestion, or undefined when the loaded model is as good as any.
 */
export function suggestModel(need: ToolNeed, loaded: { name?: string; size?: number; slotTokens?: number }, local: LocalModel[], speed: SpeedEstimate): ModelSuggestion | undefined {
  const MARGIN = 8;
  const files = local.filter((m) => !/mmproj/i.test(m.name));
  const loadedFile = loaded.name ? files.find((m) => key(m.name) === key(loaded.name!)) : undefined;
  const loadedGb = loaded.size ? gb(loaded.size) : loadedFile ? gb(loadedFile.size) : undefined;
  const now = loaded.name && loadedGb ? scoreModel(loaded.name, loadedGb, need, speed) : undefined;
  // Study loads the Hebrew model on the computer by itself (the course model "auto"): that one is what it really uses.
  const self = need.usesLocalBySelf ? files.filter((m) => toolFit(m.name, need) >= 35).map((m) => scoreModel(m.name, gb(m.size), need, speed).total) : [];
  const base = Math.max(now?.total ?? 0, ...self);
  const out: ModelSuggestion = { options: [], ...(now && loaded.name ? { loaded: { name: pretty(loaded.name), score: now } } : {}) };
  const here = files
    .filter((m) => !loaded.name || key(m.name) !== key(loaded.name))
    .map((m) => ({ m, score: scoreModel(m.name, gb(m.size), need, speed) }))
    .sort((a, b) => b.score.total - a.score.total)[0];
  const offerHere = here && here.score.total >= base + MARGIN;
  if (offerHere) out.options.push({ kind: "switch", name: pretty(here.m.name), path: here.m.path, sizeGb: gb(here.m.size), score: here.score });
  const bar = Math.max(base, here?.score.total ?? 0) + MARGIN;
  const dl = RECOMMENDED_MODELS.filter((r) => !files.some((m) => key(m.name).includes(key(r.id))))
    .map((r) => ({ r, score: scoreModel(`${r.id} ${r.name}`, r.sizeGb, need, speed, r.activeFraction) }))
    .filter((x) => x.score.total >= bar)
    .sort((a, b) => b.score.total - a.score.total)[0];
  if (dl) out.options.push({ kind: "download", name: dl.r.name, id: dl.r.id, sizeGb: dl.r.sizeGb, score: dl.score });
  if (need.minContext && !need.usesLocalBySelf && loaded.slotTokens && loaded.slotTokens < need.minContext) out.context = { have: loaded.slotTokens, want: need.minContext };
  return out.options.length || out.context ? out : undefined;
}
