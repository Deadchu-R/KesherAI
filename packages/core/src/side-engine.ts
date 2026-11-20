import { basename } from "node:path";
import type { ProviderRegistry } from "@kesher/providers";
import { LlamaEngine, freePort } from "./llamacpp.js";

/** The provider id of the second model (ids look like `llamacpp-beside/Gemma-4-E4B`). */
export const SIDE_PROVIDER = "llamacpp-beside";

/**
 * A second model beside the main one (audit F19, like Jan and LM Studio): a small, fast model for short answers and
 * helpers while the big one stays loaded. Its own llama.cpp server on a free port, the same engine files as the
 * main one; it is not remembered across restarts and is never loaded by itself (only when the user asks).
 */
export class SideEngine {
  private engine: LlamaEngine | undefined;

  /**
   * @param deps.dir - The engines folder.
   * @param deps.binary - The main engine's llama-server (undefined until it is installed).
   * @param deps.version - Its version.
   * @param deps.args - The main engine's extra arguments.
   * @param deps.registry - Where the model is offered to the chats.
   */
  constructor(private readonly deps: { dir: string; binary: () => string | undefined; version?: string; args: string[]; registry: ProviderRegistry }) {}

  /** @returns Whether a model is loaded, and which. */
  status(): { running: boolean; modelPath?: string; modelId?: string; job?: { phase: string; message: string } } {
    const st = this.engine?.status();
    if (!st) return { running: false };
    return { running: st.running, ...(st.modelPath ? { modelPath: st.modelPath, modelId: SideEngine.idOf(st.modelPath) } : {}), ...(st.job ? { job: st.job } : {}) };
  }

  /**
   * @param modelPath - A GGUF file.
   * @returns Its model id beside the main one.
   */
  static idOf(modelPath: string): string {
    return `${SIDE_PROVIDER}/${basename(modelPath).replace(/\.gguf$/i, "").replace(/[\s/]+/g, "-")}`;
  }

  /**
   * Loads a model beside the main one (a model already there is unloaded first).
   *
   * @param modelPath - A GGUF file the caller already checked (allowed folder, a real GGUF).
   * @returns Its model id.
   */
  async load(modelPath: string): Promise<string> {
    const binary = this.deps.binary();
    if (!binary) throw new Error("Install the engine first (Models → Chat).");
    await this.stop();
    this.engine = new LlamaEngine({ dir: this.deps.dir, binaryPath: binary, ...(this.deps.version ? { version: this.deps.version } : {}), port: await freePort(), args: this.deps.args, parallel: 1 });
    await this.engine.load(modelPath);
    this.deps.registry.remove(SIDE_PROVIDER);
    this.deps.registry.add({ id: SIDE_PROVIDER, type: "openai-compatible", name: "KesherAI engine, beside (llama.cpp)", location: "local", baseUrl: this.engine.baseUrl, apiKey: this.engine.apiKey, options: { llamaCpp: { slots: () => this.engine?.slots() ?? 0 } } });
    return SideEngine.idOf(modelPath);
  }

  /** Unloads it (frees its memory) and stops offering it. */
  async stop(): Promise<void> {
    this.deps.registry.remove(SIDE_PROVIDER);
    const e = this.engine;
    this.engine = undefined;
    await e?.stop("unloaded");
  }
}

const shared = new WeakMap<object, SideEngine>();

/**
 * The one beside engine of an app (by its registry), so the engine page and the translator share it.
 *
 * @param registry - The app's provider registry.
 * @param make - Makes it the first time.
 */
export function sideEngineOf(registry: ProviderRegistry, make: () => SideEngine): SideEngine {
  let e = shared.get(registry);
  if (!e) shared.set(registry, (e = make()));
  return e;
}

/**
 * The model id to translate with: a GGUF file chosen as the translator (TranslateGemma) is loaded beside the main
 * model the first time it is needed; any other choice is a model id as it is.
 *
 * @param side - The beside engine.
 * @param pick - The translator setting.
 */
export async function translatorModelId(side: SideEngine, pick: string): Promise<string> {
  if (!/\.gguf$/i.test(pick)) return pick;
  const st = side.status();
  if (st.running && st.modelPath === pick && st.modelId) return st.modelId;
  return side.load(pick);
}


/**
 * Model size per turn: the model beside the main one, when it runs and is clearly smaller (its file at most 60% of
 * the main model's), so a simple message is answered faster. Never loads a model.
 *
 * @param side - The beside engine's state.
 * @param mainPath - The main engine's model file, if one is loaded.
 * @param sizeOf - A file's size in bytes (undefined when it cannot be read).
 * @returns The small model's id, or undefined.
 */
export function smallerBeside(side: { running: boolean; modelPath?: string; modelId?: string }, mainPath: string | undefined, sizeOf: (path: string) => number | undefined): string | undefined {
  if (!side.running || !side.modelPath || !side.modelId || !mainPath) return undefined;
  const small = sizeOf(side.modelPath);
  const big = sizeOf(mainPath);
  return small && big && small <= big * 0.6 ? side.modelId : undefined;
}
