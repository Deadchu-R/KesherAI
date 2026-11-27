/**
 * Makes KesherAI's translator (translate.ts) from the server's parts: the loaded local chat model, the user's Gemini
 * connection, and the small translation model (loaded beside the main one on demand, unloaded by the GPU guard when
 * idle). Also downloads that model when the user asks (Translate page → Download).
 */
import { existsSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { listHubFiles, type DownloadManager } from "@kesher/downloads";
import type { ProviderRegistry } from "@kesher/providers";
import type { KesherConfig } from "../config.js";
import { listGgufFiles } from "../gguf-scan.js";
import type { LlamaEngine } from "../llamacpp.js";
import { modelTurnFor } from "../model-turn.js";
import { translatorModelId, type SideEngine } from "../side-engine.js";
import { TRANSLATION_MODEL, Translator, pickFlash } from "../translate.js";
import { CPU_PROVIDER, type CpuModels } from "./build-cpu-pool.js";

/** The translator's model id while it runs in the CPU pool. */
export const CPU_TRANSLATOR = `${CPU_PROVIDER}/translator`;

/** The folder the translation model is downloaded into (under the models folder). */
export const TRANSLATION_DIR = "translation";

/** The last part of a path (either separator). */
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** A file or model id reduced for comparing: no `llamacpp/` prefix, no `.gguf`, lower case, spaces as dashes. */
const comparable = (idOrPath: string): string =>
  baseName(idOrPath.replace(/^llamacpp\//i, "")).replace(/\.gguf$/i, "").replace(/[\s/]+/g, "-").toLowerCase();

/** How much a quantization is liked when several TranslateGemma files are on the computer (lower is better). */
function quantRank(file: string): number {
  const order = [/q4_k_m/i, /q5_k_m/i, /q4_k_s|q4_0/i, /q5_k_s|q5_0/i, /q6_k/i, /q8_0/i];
  const i = order.findIndex((re) => re.test(baseName(file)));
  return i < 0 ? order.length : i;
}

/**
 * The downloaded translation model, wherever the model downloader saved it:
 * 1. the translator chosen in Settings → model team, when it is a GGUF path that exists, or the id/name of a
 *    TranslateGemma file under the models folder (`PUT /api/model-team {translator}` stores either form);
 * 2. any `translategemma*.gguf` under the models folder (any folder, any quantization; Q4_K_M first);
 * 3. else the first GGUF under `models/translation` (the one-click download's folder).
 *
 * @param config - The settings.
 * @param modelsDir - The models folder.
 * @returns The file's path, or undefined when there is none.
 */
export function findTranslationFile(config: Pick<KesherConfig, "translator">, modelsDir: string): string | undefined {
  const pick = config.translator;
  if (pick && /\.gguf$/i.test(pick) && existsSync(pick)) return pick;
  const all = listGgufFiles(modelsDir);
  const gemma = all.filter((f) => /translategemma/i.test(baseName(f)) && !/mmproj/i.test(baseName(f)));
  const chosen = pick && pick !== "main" && pick !== "off" ? gemma.find((f) => comparable(f) === comparable(pick)) : undefined;
  if (chosen) return chosen;
  const best = [...gemma].sort((a, b) => quantRank(a) - quantRank(b) || (a < b ? -1 : 1))[0];
  if (best) return best;
  const dir = join(modelsDir, TRANSLATION_DIR);
  return all.find((f) => f.startsWith(dir + sep));
}

/**
 * Whether the translator chosen in Settings → model team is a model file that is on this computer (then it is used
 * before every other translator).
 *
 * @param config - The settings.
 * @param modelsDir - The models folder.
 */
export function translatorChosenAndPresent(config: Pick<KesherConfig, "translator">, modelsDir: string): boolean {
  const pick = config.translator;
  if (!pick || pick === "main" || pick === "off") return false;
  const file = findTranslationFile(config, modelsDir);
  return !!file && (file === pick || comparable(file) === comparable(pick));
}

/**
 * Builds the translator.
 *
 * @param p.registry - The providers ("gemini", the engines).
 * @param p.engine - The main chat engine (used only while it is loaded).
 * @param p.side - The engine beside the main one, where the translation model loads.
 * @param p.config - The settings.
 * @param p.modelsDir - The models folder.
 * @param p.cpu - The pool of CPU models: the translation model runs there when Settings say so (processor, or
 *   "automatic" while a game runs or the main model is loaded); otherwise beside the main model on the card.
 */
export function buildTranslator(p: { registry: ProviderRegistry; engine: LlamaEngine; side: () => SideEngine; config: KesherConfig; modelsDir: () => string; cpu?: () => CpuModels | undefined }): Translator {
  let flash: { at: number; id: string | undefined } | undefined;
  return new Translator({
    localChat: () => {
      const st = p.engine.status();
      return st.running && st.modelPath && !st.job ? `llamacpp/${basename(st.modelPath).replace(/\.gguf$/i, "").replace(/[\s/]+/g, "-")}` : undefined;
    },
    gemini: async (signal) => {
      const provider = p.registry.get("gemini");
      if (!provider) return undefined;
      // The model list is asked for at most every ten minutes.
      if (flash && Date.now() - flash.at < 600_000) return flash.id;
      const models = await provider.listModels(signal);
      flash = { at: Date.now(), id: pickFlash(models) };
      return flash.id;
    },
    translatorFile: () => findTranslationFile(p.config, p.modelsDir()),
    translatorChosen: () => translatorChosenAndPresent(p.config, p.modelsDir()),
    loadFile: async (path) => {
      const cpu = p.cpu?.();
      if (cpu && (await cpu.translatorOnCpu(p.engine.status().running))) {
        cpu.useTranslator(path);
        return CPU_TRANSLATOR;
      }
      return translatorModelId(p.side(), path);
    },
    turn: (modelId) => {
      const cpu = p.cpu?.();
      if (modelId !== CPU_TRANSLATOR || !cpu) return modelTurnFor(p.registry, modelId, { temperature: 0.2 }, "helper");
      // On the processor: plain text messages through the pool's queue (no tools, no streaming).
      return async (req, signal) => {
        const messages = req.messages.map((m) => ({ role: m.role === "system" ? ("system" as const) : m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: typeof m.content === "string" ? m.content : "" }));
        return { text: await cpu.complete("translator", messages, { temperature: 0.2 }, signal), toolCalls: [] };
      };
    },
  });
}

/**
 * Starts downloading the translation model ({@link TRANSLATION_MODEL}) into `models/translation`, unless it is there.
 *
 * @param p.downloads - The download manager.
 * @param p.modelsDir - The models folder.
 * @param p.token - The user's Hugging Face token, if set.
 * @param p.list - Lists the repository's files (tests pass their own; default Hugging Face).
 * @returns The file's path and the download job's id (none when it was already there).
 */
export async function downloadTranslationModel(p: { downloads: Pick<DownloadManager, "list" | "enqueue">; modelsDir: string; token?: string | undefined; list?: typeof listHubFiles }): Promise<{ path: string; jobId?: string }> {
  const files = await (p.list ?? listHubFiles)(TRANSLATION_MODEL.repo, { ...(p.token ? { token: p.token } : {}) });
  const file = files.find((f) => TRANSLATION_MODEL.pattern.test(f.path)) ?? files.find((f) => TRANSLATION_MODEL.fallback.test(f.path));
  if (!file) throw new Error(`No model file in ${TRANSLATION_MODEL.repo}.`);
  const dest = join(p.modelsDir, TRANSLATION_DIR, TRANSLATION_MODEL.repo, file.path);
  if (existsSync(dest)) return { path: dest };
  // A second press (a double tap, or the phone and the PC) joins the running download: two jobs would write the same
  // .part file and fetch 2.5 GB twice (scan 171).
  const running = p.downloads.list().find((j) => j.dest === dest && (j.status === "queued" || j.status === "downloading" || j.status === "verifying"));
  if (running) return { path: dest, jobId: running.id };
  const job = p.downloads.enqueue({ url: file.url, dest, size: file.size, ...(file.sha256 ? { sha256: file.sha256 } : {}), label: `${TRANSLATION_MODEL.name} · translation` });
  return { path: dest, jobId: job.id };
}
