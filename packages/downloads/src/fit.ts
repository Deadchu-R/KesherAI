/**
 * Whether a model runs on this computer, in the three marks LM Studio made familiar: it runs fully on the graphics
 * card, partly on it (the rest in system memory, slower), or it is too big. Used for every Hugging Face search result
 * (from the repo's parameter count) and for every file of a repo (from its size).
 *
 * The estimate is the weights plus the working memory: for a chat model the context's KV cache and a compute buffer,
 * for an image or video model the activations and the VAE. It is a guide, usually right within a quant step.
 */
import type { HardwareInfo } from "./hardware.js";

const GB = 1024 ** 3;

/** The three marks, plus "unknown" when the size cannot be told. */
export type RunFit = "gpu" | "partial" | "too-big" | "unknown";

/** What a model is, which decides how much working memory it needs besides its weights. */
export type ModelKind = "llm" | "mmproj" | "diffusion" | "audio" | "other";

/** The memory this computer offers a model, in bytes. */
export interface MemoryBudget {
  /** The biggest graphics card's memory (or the part of unified memory a GPU may use on a Mac). */
  vram: number;
  /** System memory. */
  ram: number;
  /** Apple Silicon and similar: one memory for both. */
  unified: boolean;
}

/** The result of {@link estimateRunFit}. */
export interface RunFitEstimate {
  fit: RunFit;
  /** Memory the model needs while running, in bytes (weights + working memory). */
  needBytes: number;
  /** Share of the model that fits on the graphics card, 0–1. */
  gpuShare: number;
}

/** Options for {@link estimateRunFit}. */
export interface RunFitOptions {
  kind?: ModelKind;
  /** Context length in tokens for chat models (default 8192, what KesherAI starts a model with). */
  contextTokens?: number;
  /** Parameters in billions when known (for the KV cache estimate); else taken from the size. */
  billions?: number;
  /** Bytes per KV element: 2 for f16, 1 for q8_0 (KesherAI's default). */
  kvBytes?: number;
}

/**
 * The memory budget of a computer from {@link detectHardware}'s result.
 *
 * @param hw - Hardware summary.
 * @returns The budget; `vram` is 0 when there is no graphics card with its own memory worth using.
 */
export function budgetOf(hw: Pick<HardwareInfo, "ramTotal" | "unifiedMemory" | "gpus">): MemoryBudget {
  if (hw.unifiedMemory) return { vram: hw.ramTotal * 0.75, ram: hw.ramTotal, unified: true };
  const vram = Math.max(0, ...hw.gpus.map((g) => g.vramTotal));
  // Built-in graphics with little memory of their own do not speed anything up.
  return { vram: vram >= 2 * GB ? vram : 0, ram: hw.ramTotal, unified: false };
}

/**
 * KV cache size for a chat model: about 45 KB per token per square root of a billion parameters at f16 (Llama 3 8B:
 * 128 KB/token; 70B with grouped-query attention: ~320 KB/token).
 *
 * @param billions - Parameters in billions.
 * @param contextTokens - Context length.
 * @param kvBytes - Bytes per element (2 for f16).
 * @returns Bytes.
 */
export function kvCacheBytes(billions: number, contextTokens: number, kvBytes = 2): number {
  return 45 * 1024 * Math.sqrt(Math.max(0.1, billions)) * contextTokens * (kvBytes / 2);
}

/**
 * How a model of a given size runs on a given budget.
 *
 * @param fileBytes - Size of the weights (one file, or all parts of a split file).
 * @param budget - From {@link budgetOf}.
 * @param opts - Kind, context, parameters, KV element size.
 * @returns The mark, the memory needed and the share on the graphics card.
 *
 * @example
 * ```ts
 * estimateRunFit(4.9 * 1024 ** 3, { vram: 12 * 1024 ** 3, ram: 32 * 1024 ** 3, unified: false }).fit; // "gpu"
 * ```
 */
export function estimateRunFit(fileBytes: number, budget: MemoryBudget, opts: RunFitOptions = {}): RunFitEstimate {
  if (!(fileBytes > 0)) return { fit: "unknown", needBytes: 0, gpuShare: 0 };
  const kind = opts.kind ?? "llm";
  let need: number;
  if (kind === "llm") {
    // A 4-bit file is ~0.6 GB per billion parameters; without a count, take that.
    const billions = opts.billions ?? fileBytes / GB / 0.6;
    need = fileBytes + kvCacheBytes(billions, opts.contextTokens ?? 8192, opts.kvBytes ?? 2) + 0.5 * GB;
  } else if (kind === "mmproj") need = fileBytes * 1.1 + 0.3 * GB;
  else if (kind === "diffusion") need = fileBytes * 1.15 + 1.5 * GB;
  else if (kind === "audio") need = fileBytes * 1.2 + 0.4 * GB;
  else need = fileBytes * 1.2;
  // Leave room for the desktop and the driver.
  const usableVram = budget.unified ? budget.vram : Math.max(0, budget.vram - Math.max(0.5 * GB, budget.vram * 0.06));
  const gpuShare = usableVram > 0 ? Math.min(1, usableVram / need) : 0;
  const round = (n: number) => Math.round(n * 100) / 100;
  if (usableVram > 0 && need <= usableVram) return { fit: "gpu", needBytes: need, gpuShare: 1 };
  // Unified memory has nowhere else to spill; elsewhere the engines move layers into system memory, more slowly.
  const spill = budget.unified ? budget.ram * 0.85 - usableVram : budget.ram * 0.6;
  if (need <= usableVram + Math.max(0, spill)) return { fit: "partial", needBytes: need, gpuShare: round(gpuShare) };
  return { fit: "too-big", needBytes: need, gpuShare: round(gpuShare) };
}

/** Bits per weight of common GGUF quants (llama.cpp's own figures, rounded). */
const QUANT_BITS: Array<[RegExp, number]> = [
  [/^(F32)$/, 32], [/^(F16|BF16)$/, 16], [/^Q8_0$/, 8.5], [/^Q6_K/, 6.6], [/^Q5_K/, 5.7], [/^Q5_[01]$/, 5.5],
  [/^Q4_K/, 4.85], [/^Q4_[01]$/, 4.5], [/^IQ4/, 4.4], [/^Q3_K_L$/, 4.3], [/^Q3_K_M$/, 3.9], [/^Q3_K/, 3.5],
  [/^IQ3/, 3.4], [/^Q2_K/, 3.0], [/^IQ2/, 2.4], [/^IQ1/, 1.8], [/^FP8|^F8/, 8],
];

/**
 * The quant of a weights file from its name: `Qwen3-8B-Q4_K_M.gguf` → `Q4_K_M`, `flux1-dev-fp8.safetensors` → `FP8`.
 *
 * @param path - File path inside the repo.
 * @returns The quant in upper case, or undefined.
 */
export function quantOf(path: string): string | undefined {
  const name = path.split("/").pop() ?? path;
  const m = /(?:^|[-_.])(I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|FP16|FP8(?:_E4M3FN)?|F8)(?=[-_.])/i.exec(name);
  if (!m) return undefined;
  const q = m[1]!.toUpperCase();
  return q === "FP16" ? "F16" : q;
}

/**
 * Bits per weight of a quant, for turning a parameter count into a size.
 *
 * @param quant - From {@link quantOf}.
 * @returns Bits, or undefined for an unknown quant.
 */
export function quantBits(quant: string): number | undefined {
  return QUANT_BITS.find(([re]) => re.test(quant))?.[1];
}

/**
 * What a file is, from its name and the repo's task: a vision add-on for a chat model (mmproj), a chat model, an image
 * or video model, a voice model.
 *
 * @param path - File path inside the repo.
 * @param pipelineTag - The repo's Hugging Face task, e.g. `text-to-image`.
 * @returns The kind.
 */
export function fileKind(path: string, pipelineTag?: string): ModelKind {
  if (/mmproj|clip[-_]?vision|vision[-_]?(proj|adapter)/i.test(path)) return "mmproj";
  const tag = pipelineTag ?? "";
  if (/to-image|to-video|image-to-image|text-to-3d|image-to-3d/.test(tag)) return "diffusion";
  if (/speech|audio/.test(tag)) return "audio";
  if (/\.gguf$/i.test(path) || /text-generation|image-text-to-text/.test(tag)) return "llm";
  return "other";
}

/**
 * A repo's run mark before its files are listed: the size of a 4-bit build (GGUF repos) or of the weights as stored
 * (safetensors repos), from the parameter count the Hub reports, else the "8B" in the name.
 *
 * @param m - Parameter count (`params`), size in the name (`parameters`, e.g. `8B`), stored precision (`dtypeBytes`),
 *   whether it is a GGUF repo, and the task.
 * @param budget - From {@link budgetOf}.
 * @returns The estimate and the size it assumed (bytes), or `unknown`.
 */
export function estimateRepoFit(
  m: { params?: number; parameters?: string; dtypeBytes?: number; gguf: boolean; pipelineTag?: string },
  budget: MemoryBudget,
): RunFitEstimate & { assumedBytes: number } {
  let params = m.params;
  if (!params && m.parameters) {
    const p = /^(\d+(?:\.\d+)?)([BM])$/i.exec(m.parameters);
    if (p) params = Number(p[1]) * (p[2]!.toUpperCase() === "B" ? 1e9 : 1e6);
  }
  if (!params) return { fit: "unknown", needBytes: 0, gpuShare: 0, assumedBytes: 0 };
  const bytesPerParam = m.gguf ? 4.85 / 8 : (m.dtypeBytes ?? 2);
  const bytes = params * bytesPerParam;
  const kind = fileKind(m.gguf ? "x.gguf" : "x.safetensors", m.pipelineTag);
  return { ...estimateRunFit(bytes, budget, { kind, billions: params / 1e9 }), assumedBytes: bytes };
}

/**
 * Groups the parts of split GGUF files (`model-00001-of-00003.gguf`) so a quant's size is all its parts together.
 *
 * @param path - File path.
 * @returns The group key: the path without the part number, or the path itself.
 */
export function splitGroup(path: string): string {
  return path.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, "");
}
