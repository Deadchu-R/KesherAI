/**
 * Makes KesherAI's translator (translate.ts) from the server's parts: the loaded local chat model, the user's Gemini
 * connection, and the small translation model (loaded beside the main one on demand, unloaded by the GPU guard when
 * idle). Also downloads that model when the user asks (Translate page → Download).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { listHubFiles, type DownloadManager } from "@kesher/downloads";
import type { ProviderRegistry } from "@kesher/providers";
import type { KesherConfig } from "../config.js";
import type { LlamaEngine } from "../llamacpp.js";
import { modelTurnFor } from "../model-turn.js";
import { translatorModelId, type SideEngine } from "../side-engine.js";
import { TRANSLATION_MODEL, Translator, pickFlash } from "../translate.js";

/** The folder the translation model is downloaded into (under the models folder). */
export const TRANSLATION_DIR = "translation";

/**
 * The downloaded translation model: the translator chosen in Settings → model team when it is a GGUF file, else the
 * first GGUF under `models/translation`.
 *
 * @param config - The settings.
 * @param modelsDir - The models folder.
 */
export function findTranslationFile(config: Pick<KesherConfig, "translator">, modelsDir: string): string | undefined {
  const pick = config.translator;
  if (pick && /\.gguf$/i.test(pick) && existsSync(pick)) return pick;
  const walk = (dir: string, depth: number): string | undefined => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return undefined;
    }
    for (const n of names.sort()) {
      const p = join(dir, n);
      if (/\.gguf$/i.test(n)) return p;
      if (depth > 0 && !n.startsWith(".") && statSync(p, { throwIfNoEntry: false })?.isDirectory()) {
        const found = walk(p, depth - 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(join(modelsDir, TRANSLATION_DIR), 3);
}

/**
 * Builds the translator.
 *
 * @param p.registry - The providers ("gemini", the engines).
 * @param p.engine - The main chat engine (used only while it is loaded).
 * @param p.side - The engine beside the main one, where the translation model loads.
 * @param p.config - The settings.
 * @param p.modelsDir - The models folder.
 */
export function buildTranslator(p: { registry: ProviderRegistry; engine: LlamaEngine; side: () => SideEngine; config: KesherConfig; modelsDir: () => string }): Translator {
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
    loadFile: (path) => translatorModelId(p.side(), path),
    turn: (modelId) => modelTurnFor(p.registry, modelId, { temperature: 0.2 }, "helper"),
  });
}

/**
 * Starts downloading the translation model ({@link TRANSLATION_MODEL}) into `models/translation`, unless it is there.
 *
 * @param p.downloads - The download manager.
 * @param p.modelsDir - The models folder.
 * @param p.token - The user's Hugging Face token, if set.
 * @returns The file's path and the download job's id (none when it was already there).
 */
export async function downloadTranslationModel(p: { downloads: DownloadManager; modelsDir: string; token?: string | undefined }): Promise<{ path: string; jobId?: string }> {
  const files = await listHubFiles(TRANSLATION_MODEL.repo, { ...(p.token ? { token: p.token } : {}) });
  const file = files.find((f) => TRANSLATION_MODEL.pattern.test(f.path)) ?? files.find((f) => TRANSLATION_MODEL.fallback.test(f.path));
  if (!file) throw new Error(`No model file in ${TRANSLATION_MODEL.repo}.`);
  const dest = join(p.modelsDir, TRANSLATION_DIR, TRANSLATION_MODEL.repo, file.path);
  if (existsSync(dest)) return { path: dest };
  const job = p.downloads.enqueue({ url: file.url, dest, size: file.size, ...(file.sha256 ? { sha256: file.sha256 } : {}), label: `${TRANSLATION_MODEL.name} · translation` });
  return { path: dest, jobId: job.id };
}
