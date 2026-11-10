import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { listHubFiles } from "@kesher/downloads";
import type { ProviderRegistry } from "@kesher/providers";
import type { DownloadManager } from "@kesher/downloads";
import { LlamaEngine, waitForDownload } from "./llamacpp.js";
import { pickEmbedding, scanComputer, scanFolder } from "./model-scan.js";
import type { Embedder } from "./knowledge.js";
import type { KesherConfig } from "./config.js";

/**
 * Search by meaning: an embedding model turns passages and questions into
 * vectors, so "how do I get my money back" finds the refund policy. KesherAI
 * runs a small multilingual one (Qwen3 Embedding 0.6B, Apache-2.0, Hebrew
 * included) in a second llama.cpp server on this computer, or uses any
 * embedding model the user made active (Ollama, LM Studio, OpenAI).
 */

/** The model KesherAI downloads for it. */
export const EMBEDDING_MODEL = { repo: "Qwen/Qwen3-Embedding-0.6B-GGUF", pattern: /Q8_0\.gguf$/i, fallback: /\.gguf$/i, name: "Qwen3 Embedding 0.6B", sizeGb: 0.64 };

/** The built-in embedding engine's provider id. */
export const EMBED_PROVIDER = "llamacpp-embed";

/**
 * Words some embedding models want before a question or a passage.
 *
 * @param modelId - The model.
 * @param text - The text.
 * @param kind - Question or passage.
 * @returns The text to embed.
 */
export function embedText(modelId: string, text: string, kind: "query" | "doc"): string {
  if (/qwen3-embedding/i.test(modelId)) return kind === "query" ? `Instruct: Given a question, retrieve passages that answer it\nQuery: ${text}` : text;
  if (/e5/i.test(modelId)) return `${kind === "query" ? "query" : "passage"}: ${text}`;
  if (/nomic-embed/i.test(modelId)) return `${kind === "query" ? "search_query" : "search_document"}: ${text}`;
  return text;
}

/** Runs and sets up the embedding model. */
export class Semantic {
  private engine?: LlamaEngine;
  phase?: "downloading" | "loading" | "error";
  message?: string;

  /** @param d - What it needs. */
  constructor(
    private readonly d: {
      config: KesherConfig;
      registry: ProviderRegistry;
      downloads: DownloadManager;
      modelsDir: () => string;
      enginesDir: string;
      /** The llama.cpp binary (installs it when missing). */
      binary: () => Promise<string>;
      save: () => Promise<void>;
      /** Called when a model becomes active (re-index the knowledge bases). */
      changed: () => void;
    },
  ) {}

  /** @returns The embedder for the active embedding model, if there is one. */
  embedder(): Embedder | undefined {
    const id = this.d.config.activeModels.embedding;
    if (!id) return undefined;
    let target;
    try {
      target = this.d.registry.resolve(id);
    } catch {
      return undefined;
    }
    const embed = target.provider.embed?.bind(target.provider);
    if (!embed) return undefined;
    return { id, embed: (texts, kind) => embed({ providerModelId: target.providerModelId, input: texts.map((t) => embedText(id, t, kind).slice(0, 6000)) }) };
  }

  /** @returns What the knowledge page shows. */
  status() {
    return { active: this.d.config.activeModels.embedding ?? null, usable: !!this.embedder(), builtIn: this.d.config.activeModels.embedding?.startsWith(`${EMBED_PROVIDER}/`) ?? false, ...(this.phase ? { phase: this.phase } : {}), ...(this.message ? { message: this.message } : {}), model: EMBEDDING_MODEL };
  }

  /** Starts the built-in engine with a model file and makes it the active embedding model. */
  async load(path: string): Promise<string> {
    // No forced GPU layers: when the chat model fills the card, this small model fits on the processor instead.
    this.engine ??= new LlamaEngine({ dir: this.d.enginesDir, binaryPath: await this.d.binary(), ...(this.d.config.engines.llamaVersion ? { version: this.d.config.engines.llamaVersion } : {}), port: 8082, args: ["--embedding", "-c", "8192", "-ub", "8192", "-b", "8192"] });
    await this.engine.load(path, 180_000);
    if (!this.d.registry.get(EMBED_PROVIDER)) this.d.registry.add({ id: EMBED_PROVIDER, type: "openai-compatible", name: "KesherAI embeddings (llama.cpp)", location: "local", baseUrl: this.engine.baseUrl });
    const id = `${EMBED_PROVIDER}/${basename(path).replace(/\.gguf$/i, "")}`;
    this.d.config.activeModels.embedding = id;
    this.d.config.engines.embedModel = path;
    await this.d.save();
    return id;
  }

  /** On start: runs the built-in embedding model again if it was set up. */
  async resume(): Promise<void> {
    const p = this.d.config.engines.embedModel;
    if (p && existsSync(p) && (!this.d.config.activeModels.embedding || this.d.config.activeModels.embedding.startsWith(`${EMBED_PROVIDER}/`))) await this.load(p);
  }

  /** Downloads the built-in model if needed, starts it, and re-indexes. Started by the user. */
  async setup(): Promise<void> {
    this.phase = "downloading";
    this.message = `Finding ${EMBEDDING_MODEL.name}…`;
    try {
      // Already on this computer (LM Studio, Ollama, Hugging Face…): use it where it is, no download.
      const own = await scanFolder({ folder: join(this.d.modelsDir(), "embedding"), source: "KesherAI" }, 6).catch(() => []);
      const onComputer = pickEmbedding([...own, ...(await scanComputer(this.d.config.modelFolders).catch(() => [])).flatMap((f) => f.models)]);
      if (onComputer) {
        this.phase = "loading";
        this.message = `Starting ${basename(onComputer.path)} (already on this computer, from ${onComputer.source})…`;
        await this.load(onComputer.path);
        this.phase = undefined;
        this.message = "Search by meaning is on. The knowledge bases are being indexed again.";
        this.d.changed();
        return;
      }
      const files = await listHubFiles(EMBEDDING_MODEL.repo, { ...(this.d.config.huggingFaceToken ? { token: this.d.config.huggingFaceToken } : {}) });
      const file = files.find((f) => EMBEDDING_MODEL.pattern.test(f.path)) ?? files.find((f) => EMBEDDING_MODEL.fallback.test(f.path));
      if (!file) throw new Error(`No model file in ${EMBEDDING_MODEL.repo}.`);
      const dest = join(this.d.modelsDir(), "embedding", EMBEDDING_MODEL.repo, file.path);
      if (!existsSync(dest)) {
        this.message = `Downloading ${EMBEDDING_MODEL.name} (${EMBEDDING_MODEL.sizeGb} GB)…`;
        const job = this.d.downloads.enqueue({ url: file.url, dest, size: file.size, ...(file.sha256 ? { sha256: file.sha256 } : {}), label: `${EMBEDDING_MODEL.name} · search by meaning` });
        await waitForDownload(this.d.downloads, job.id);
      }
      this.phase = "loading";
      this.message = "Starting the embedding model…";
      await this.load(dest);
      this.phase = undefined;
      this.message = "Search by meaning is on. The knowledge bases are being indexed again.";
      this.d.changed();
    } catch (e) {
      this.phase = "error";
      this.message = (e as Error).message;
      throw e;
    }
  }

  /** Stops the built-in engine. */
  async stop(): Promise<void> {
    await this.engine?.stop();
  }
}
