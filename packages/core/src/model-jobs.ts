/**
 * "Models per job" (Settings): every job KesherAI runs a model for, the model it uses now, and, when it has none or
 * the chosen file is gone, the one model that fits this computer best, offered for one tap. Nothing downloads without
 * that tap; the tap posts the job's existing setup route (the same ones the Models page uses), which downloads through
 * the downloads manager and makes the model the job's model when it is done. docs/MODEL_CATEGORIES.md lists the
 * same jobs with their APIs; RESEARCH_LOG "A model for every job, one tap" has how others do it.
 *
 * The picking is pure (this file, tested); routes/model-jobs.ts gathers the facts.
 */
import { estimateRunFit, type MemoryBudget, type RunFit } from "@kesher/downloads";
import { RECOMMENDED_MODELS, ROUTER_MODEL } from "@kesher/shared";
import { pickStarterModels } from "./starter-models.js";

const GB = 1024 ** 3;

/** The jobs, in the order the card shows them. */
export const MODEL_JOB_IDS = ["chat", "router", "image", "video", "speech-to-text", "text-to-speech", "embedding", "music", "3d", "translator", "vision"] as const;
/** One job of the card. */
export type ModelJobId = (typeof MODEL_JOB_IDS)[number];

/**
 * A job's state: `ready` (has a model), `busy` (setting up), `missing` (the chosen file is gone), `none` (no model),
 * `manual` (chosen elsewhere: ComfyUI or its own settings section; no one-tap download).
 */
export type ModelJobState = "ready" | "busy" | "missing" | "none" | "manual";

/** What one tap does for a job without a model. */
export interface ModelJobSuggestion {
  name: string;
  /** Download size in GB; 0 when the model is already on the computer. */
  sizeGb: number;
  fit: RunFit;
  /** Already on this computer: the tap only turns it on. */
  onComputer: boolean;
  /** The existing route the tap posts. */
  setup: string;
  body?: Record<string, unknown>;
  /** False when this job can be set up only on the computer itself (asked from the phone). */
  canSetup: boolean;
}

/** One row of the card. */
export interface ModelJob {
  id: ModelJobId;
  state: ModelJobState;
  /** The model it uses now (a short name), or null. */
  current: string | null;
  suggestion?: ModelJobSuggestion;
  /** Where to choose it by hand (an app address). */
  link: string;
}

/** A local GGUF file (from the look over this computer). */
export interface LocalFile {
  path: string;
  name: string;
  size: number;
}

/** Everything the picking needs, gathered by the route. */
export interface ModelJobFacts {
  /** activeModels from the settings. */
  active: Record<string, string>;
  /** The biggest card and memory (undefined: unknown, then only small models are suggested). */
  budget?: MemoryBudget;
  /** Hebrew interface (shapes the chat pick). */
  hebrew: boolean;
  /** The request comes from this computer (some setups are only allowed there). */
  local: boolean;
  /** Chat GGUFs on this computer (KesherAI's folder and the user's model folders). */
  chatFiles: LocalFile[];
  /** The engine is installing or loading a model right now. */
  engineBusy: boolean;
  /** llama.cpp is installed (the router's setup needs it; the chat setup installs it). */
  engineInstalled: boolean;
  /** The router's file on this computer, if any. */
  routerFile?: string;
  image: { fileMissing: boolean; busy: boolean };
  video: { ready: boolean; busy: boolean; model?: string; sizeGb: number; name: string };
  stt: { ready: boolean; busy: boolean; model?: string; possible: boolean; label: string; sizeGb: number };
  tts: { ready: boolean; busy: boolean; sizeGb: number };
  embedding: { ready: boolean; busy: boolean; model?: string; name: string; sizeGb: number; onComputer?: string };
  /** The model team's translator setting (`main`, `off` or a model id). */
  translator: string;
  /** Computer control's vision choice. */
  vision: string;
}

/** Files that are not chat models (vision add-ons, embeddings, speech) even though they are GGUF. */
const NOT_CHAT = /mmproj|embed|whisper|ggml-model|translat|vae|clip|(^|[-_])u?m?t5|qwen-image|flux|wan2/i;

/** @returns A short display name for a model id or file path. */
export function shortName(idOrPath: string): string {
  const base = idOrPath.split(/[\\/]/).pop() ?? idOrPath;
  return base.replace(/\.(gguf|safetensors|bin)$/i, "");
}

/** @returns The engine id of a GGUF file (as routes/engine.ts names it). */
function engineId(file: string): string {
  return `llamacpp/${shortName(file).replace(/[\s/]+/g, "-")}`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The chat suggestion: the biggest chat model already on this computer that fits fully on the graphics card (load
 * it, nothing to download); else the best model from the "Start here" list for this computer (pickStarterModels).
 *
 * @param f - The facts.
 * @returns The suggestion, or undefined when nothing runs here.
 */
export function chatSuggestion(f: ModelJobFacts): ModelJobSuggestion | undefined {
  if (f.budget) {
    const fits = f.chatFiles
      .filter((m) => !NOT_CHAT.test(m.name) && m.size >= 2 * GB)
      .map((m) => ({ m, fit: estimateRunFit(m.size, f.budget!, { kind: "llm" }).fit }))
      .filter((x) => x.fit === "gpu")
      .sort((a, b) => b.m.size - a.m.size);
    const own = fits[0];
    if (own) return { name: shortName(own.m.name), sizeGb: 0, fit: "gpu", onComputer: true, setup: "/api/engines/llamacpp/load", body: { modelPath: own.m.path }, canSetup: !f.engineBusy };
  }
  const budget = f.budget ?? { vram: 0, ram: 8 * GB, unified: false };
  const pick = pickStarterModels(RECOMMENDED_MODELS, budget, { roles: [], hebrew: f.hebrew })[0];
  const m = pick && RECOMMENDED_MODELS.find((x) => x.id === pick.id);
  if (!pick || !m) return undefined;
  return { name: m.name, sizeGb: m.sizeGb, fit: pick.fit, onComputer: false, setup: `/api/models/recommended/${encodeURIComponent(m.id)}/run`, canSetup: !f.engineBusy };
}

/**
 * Builds the card's rows from the facts.
 *
 * @param f - What the route found on this computer.
 * @param pickImage - The recommended image model for a card size (sdcpp.ts imagePickFor).
 * @returns One row per job, in MODEL_JOB_IDS order.
 */
export function buildModelJobs(f: ModelJobFacts, pickImage: (vramGb: number) => { name: string; sizeGb: number }): ModelJob[] {
  const fitOf = (gb: number, kind: "diffusion" | "audio" | "llm") => (f.budget ? estimateRunFit(gb * GB, f.budget, { kind }).fit : "unknown");
  const jobs: ModelJob[] = [];

  // Chat: the active model, missing when it is a built-in engine model whose file is no longer on the computer.
  const chat = f.active.chat;
  const chatMissing = !!chat && chat.startsWith("llamacpp/") && !f.chatFiles.some((m) => engineId(m.name) === chat);
  const chatState: ModelJobState = f.engineBusy && (!chat || chatMissing) ? "busy" : !chat ? "none" : chatMissing ? "missing" : "ready";
  const chatSug = chatState === "none" || chatState === "missing" ? chatSuggestion(f) : undefined;
  jobs.push({ id: "chat", state: chatState, current: chat ? shortName(chat) : null, ...(chatSug ? { suggestion: chatSug } : {}), link: "#/models" });

  // The small model beside (Auto's router and small turns).
  jobs.push({
    id: "router",
    state: f.routerFile ? "ready" : "none",
    current: f.routerFile ? shortName(f.routerFile) : null,
    ...(f.routerFile ? {} : { suggestion: { name: ROUTER_MODEL.name, sizeGb: ROUTER_MODEL.sizeGb, fit: fitOf(ROUTER_MODEL.memoryGb, "llm"), onComputer: false, setup: "/api/model-router/router/setup", canSetup: f.engineInstalled } }),
    link: "#/settings/general",
  });

  // Pictures.
  const image = f.active.image;
  const imageState: ModelJobState = f.image.busy ? "busy" : !image ? "none" : f.image.fileMissing ? "missing" : "ready";
  const imgPick = pickImage(f.budget ? f.budget.vram / GB : 0);
  jobs.push({
    id: "image",
    state: imageState,
    current: image ? shortName(image) : null,
    ...(imageState === "none" || imageState === "missing" ? { suggestion: { name: imgPick.name, sizeGb: imgPick.sizeGb, fit: fitOf(imgPick.sizeGb, "diffusion"), onComputer: false, setup: "/api/models/setup/media/image", canSetup: true } } : {}),
    link: "#/models",
  });

  // Video.
  const v = f.video;
  const videoState: ModelJobState = v.busy ? "busy" : v.ready ? "ready" : f.active.video ? "missing" : "none";
  jobs.push({
    id: "video",
    state: videoState,
    current: v.model ?? (f.active.video ? shortName(f.active.video) : null),
    ...(videoState === "none" || videoState === "missing" ? { suggestion: { name: v.name, sizeGb: v.sizeGb, fit: fitOf(v.sizeGb, "diffusion"), onComputer: false, setup: "/api/models/setup/media/video", canSetup: true } } : {}),
    link: "#/models",
  });

  // Speech to text: Hebrew speakers also get ivrit-ai's Hebrew model.
  const s = f.stt;
  const sttState: ModelJobState = s.busy ? "busy" : s.ready ? "ready" : "none";
  jobs.push({
    id: "speech-to-text",
    state: sttState,
    current: s.model ?? null,
    ...(sttState === "none" && s.possible ? { suggestion: { name: s.label, sizeGb: round1(s.sizeGb + (f.hebrew ? 1.62 : 0)), fit: fitOf(s.sizeGb, "audio"), onComputer: false, setup: "/api/speech/stt/setup", body: { hebrew: f.hebrew }, canSetup: true } } : {}),
    link: "#/settings/general",
  });

  // Text to speech (Kokoro).
  const t = f.tts;
  const ttsState: ModelJobState = t.busy ? "busy" : t.ready ? "ready" : "none";
  jobs.push({
    id: "text-to-speech",
    state: ttsState,
    current: t.ready ? "Kokoro" : null,
    ...(ttsState === "none" ? { suggestion: { name: "Kokoro", sizeGb: round1(t.sizeGb), fit: fitOf(t.sizeGb, "audio"), onComputer: false, setup: "/api/speech/tts/local/setup", canSetup: true } } : {}),
    link: "#/models",
  });

  // Search by meaning: a model already on the computer is used in place. Its setup route is computer-only.
  const e = f.embedding;
  const embState: ModelJobState = e.busy ? "busy" : e.ready ? "ready" : f.active.embedding ? "missing" : "none";
  jobs.push({
    id: "embedding",
    state: embState,
    current: e.model ?? (f.active.embedding ? shortName(f.active.embedding) : null),
    ...(embState === "none" || embState === "missing"
      ? { suggestion: { name: e.onComputer ? shortName(e.onComputer) : e.name, sizeGb: e.onComputer ? 0 : e.sizeGb, fit: fitOf(e.sizeGb, "llm"), onComputer: !!e.onComputer, setup: "/api/knowledge/semantic/setup", canSetup: f.local } }
      : {}),
    link: "#/knowledge",
  });

  // Chosen elsewhere: music and 3D in ComfyUI, the translator and computer vision in their own sections.
  jobs.push({ id: "music", state: f.active.music ? "ready" : "manual", current: f.active.music ? shortName(f.active.music) : null, link: "#/nodes" });
  jobs.push({ id: "3d", state: f.active["3d"] ? "ready" : "manual", current: f.active["3d"] ? shortName(f.active["3d"]) : null, link: "#/nodes" });
  jobs.push({ id: "translator", state: "manual", current: f.translator === "main" || f.translator === "off" ? f.translator : shortName(f.translator), link: "#/settings/chats" });
  jobs.push({ id: "vision", state: "manual", current: f.vision, link: "#/settings/privacy" });
  return jobs;
}

/**
 * What "Set up everything missing" would do: the jobs with a suggestion that can be set up from here, and the total
 * download.
 *
 * @param jobs - The card's rows.
 * @returns The jobs to set up, in order (chat first: others may need its engine), and the total in GB.
 */
export function setupAllPlan(jobs: readonly ModelJob[]): { jobs: ModelJob[]; totalGb: number } {
  const list = jobs.filter((j) => (j.state === "none" || j.state === "missing") && j.suggestion?.canSetup);
  return { jobs: list, totalGb: round1(list.reduce((n, j) => n + (j.suggestion?.sizeGb ?? 0), 0)) };
}
