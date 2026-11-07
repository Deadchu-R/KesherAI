import { execFile } from "node:child_process";
import { freemem, totalmem, platform, cpus } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

/** What the machine has, as far as KesherAI can tell. */
export interface HardwareInfo {
  platform: NodeJS.Platform;
  cpu: string;
  /** Total system RAM in bytes. */
  ramTotal: number;
  /** Free system RAM in bytes. */
  ramFree: number;
  /** One entry per NVIDIA GPU found through `nvidia-smi`; empty otherwise. */
  gpus: Array<{ name: string; vramTotal: number; vramFree: number }>;
  /**
   * On Apple Silicon, GPU and CPU share memory, so RAM is also the model budget.
   */
  unifiedMemory: boolean;
}

/**
 * Detects RAM and NVIDIA GPUs. Never throws: a missing `nvidia-smi` simply
 * means an empty `gpus` list.
 *
 * AMD (ROCm) and Intel GPUs are not detected yet; contributions welcome.
 *
 * @returns Hardware summary.
 */
export async function detectHardware(): Promise<HardwareInfo> {
  const gpus: HardwareInfo["gpus"] = [];
  try {
    const { stdout } = await run(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      { timeout: 3000 },
    );
    for (const line of stdout.trim().split("\n")) {
      const [name, total, free] = line.split(",").map((s) => s.trim());
      if (name && total && free) gpus.push({ name, vramTotal: Number(total) * 1024 ** 2, vramFree: Number(free) * 1024 ** 2 });
    }
  } catch {
    // No NVIDIA driver, or nvidia-smi not on PATH.
  }
  const cpu = cpus()[0]?.model ?? "unknown";
  return {
    platform: platform(),
    cpu,
    ramTotal: totalmem(),
    ramFree: freemem(),
    gpus,
    unifiedMemory: platform() === "darwin" && /Apple/i.test(cpu),
  };
}

/** How well a model file fits the machine. */
export type Fit = "fits" | "tight" | "too-big";

/**
 * Rough guess of whether a model fits in memory.
 *
 * Rule of thumb: weights plus ~20% for context and activations. "fits"
 * means it fits in VRAM (or unified memory); "tight" means it needs CPU
 * offload or nearly all of VRAM; "too-big" means not even RAM + VRAM.
 *
 * @param fileBytes - Size of the weights file(s).
 * @param hw - Result of {@link detectHardware}.
 * @returns The fit badge to show.
 */
export function estimateFit(fileBytes: number, hw: HardwareInfo): Fit {
  const needed = fileBytes * 1.2;
  const vram = hw.unifiedMemory ? hw.ramTotal * 0.75 : Math.max(0, ...hw.gpus.map((g) => g.vramTotal));
  if (needed <= vram * 0.9) return "fits";
  if (needed <= vram + hw.ramTotal * 0.7) return "tight";
  return "too-big";
}

/**
 * Memory bandwidth (GB/s) of common GPUs, matched against the name
 * nvidia-smi reports. Text generation speed is limited mostly by how fast
 * the weights can be read, so bandwidth is the best single predictor.
 * Unknown NVIDIA cards fall back to a mid-range value.
 */
const GPU_BANDWIDTH: Array<[RegExp, number]> = [
  [/5090/, 1792], [/5080/, 960], [/5070 Ti/i, 896], [/5070/, 672], [/5060 Ti/i, 448], [/5060/, 448],
  [/4090/, 1008], [/4080/, 717], [/4070 Ti Super/i, 672], [/4070 Ti/i, 504], [/4070 Super/i, 504], [/4070/, 504],
  [/4060 Ti/i, 288], [/4060/, 272],
  [/3090/, 936], [/3080 Ti/i, 912], [/3080/, 760], [/3070 Ti/i, 608], [/3070/, 448], [/3060 Ti/i, 448], [/3060/, 360], [/3050/, 224],
  [/2080 Ti/i, 616], [/2080/, 448], [/2070/, 448], [/2060/, 336], [/1660/, 192], [/1080 Ti/i, 484], [/1080/, 320], [/1070/, 256],
  [/A100/, 1555], [/H100/, 3350], [/L40/, 864], [/A6000/, 768], [/A4000/, 448],
];

/** Typical system RAM bandwidth (GB/s) when the CPU does the work. */
const CPU_BANDWIDTH = 50;

/** Apple Silicon unified memory bandwidth (GB/s) by chip name. */
function appleBandwidth(cpu: string): number {
  if (/Ultra/i.test(cpu)) return 800;
  if (/Max/i.test(cpu)) return 400;
  if (/Pro/i.test(cpu)) return 200;
  if (/M4/i.test(cpu)) return 120;
  return 100;
}

/**
 * Bandwidth of the computer's best GPU, or of unified memory on a Mac.
 *
 * @param hw - Result of {@link detectHardware}.
 * @returns GB/s, or 0 when there is no usable GPU.
 */
export function gpuBandwidth(hw: HardwareInfo): number {
  if (hw.unifiedMemory) return appleBandwidth(hw.cpu);
  const best = [...hw.gpus].sort((a, b) => b.vramTotal - a.vramTotal)[0];
  if (!best) return 0;
  return GPU_BANDWIDTH.find(([re]) => re.test(best.name))?.[1] ?? 300;
}

/** How well a model will run here. */
export type Rating = "good" | "ok" | "slow" | "too-big";

/** A time estimate for one everyday task. */
export interface TaskEstimate {
  /** Key for the UI's translations: `short-answer`, `long-answer`, `load`, `read-file`. */
  task: "short-answer" | "long-answer" | "load" | "read-file";
  seconds: number;
}

/** Everything the UI shows about how a model will run on this computer. */
export interface PerformanceEstimate {
  rating: Rating;
  fit: Fit;
  /** Expected writing speed. */
  tokensPerSecond: number;
  /** Roughly words per second (a token is about ¾ of an English word). */
  wordsPerSecond: number;
  /** Share of the model that fits on the GPU, 0–1. */
  gpuShare: number;
  tasks: TaskEstimate[];
}

/**
 * Estimates how fast a model will run on this computer.
 *
 * Writing speed ≈ efficiency × bandwidth ÷ bytes read per token. The part
 * of the model in VRAM is read at GPU speed, the rest at RAM speed. For
 * mixture-of-experts models only the active experts are read per token,
 * so pass `activeFraction` (e.g. 0.1 for a 30B model with 3B active).
 * Prompt reading (prefill) is compute-bound and much faster than writing;
 * it is estimated as a multiple of writing speed.
 *
 * These are estimates, typically within a factor of two; the UI says so.
 *
 * @param fileBytes - Size of the weights.
 * @param hw - Result of {@link detectHardware}.
 * @param opts.activeFraction - Share of weights used per token (default 1).
 * @returns The estimate.
 */
export function estimatePerformance(fileBytes: number, hw: HardwareInfo, opts: { activeFraction?: number } = {}): PerformanceEstimate {
  const fit = estimateFit(fileBytes, hw);
  const GB = 1024 ** 3;
  const sizeGb = fileBytes / GB;
  const active = sizeGb * Math.min(1, Math.max(0.02, opts.activeFraction ?? 1));
  const gpuBw = gpuBandwidth(hw);
  const vramGb = hw.unifiedMemory ? (hw.ramTotal * 0.75) / GB : Math.max(0, ...hw.gpus.map((g) => g.vramTotal)) / GB;
  // Leave room for the context (KV cache) and the desktop.
  const usableVram = Math.max(0, vramGb * 0.9 - 1);
  const gpuShare = gpuBw > 0 ? Math.min(1, usableVram / (sizeGb * 1.1)) : 0;
  const efficiency = 0.6;
  const secondsPerToken = (active * gpuShare) / (gpuBw || 1) + (active * (1 - gpuShare)) / CPU_BANDWIDTH;
  const tokensPerSecond = fit === "too-big" ? 0 : Math.max(0.1, efficiency / secondsPerToken);
  const prefillPerSecond = tokensPerSecond * (gpuShare > 0.9 ? 40 : gpuShare > 0 ? 10 : 6);
  const diskGbPerSecond = 1.2;
  const rating: Rating = fit === "too-big" ? "too-big" : tokensPerSecond >= 20 ? "good" : tokensPerSecond >= 7 ? "ok" : "slow";
  const round = (n: number) => Math.round(n * 10) / 10;
  const tasks: TaskEstimate[] =
    fit === "too-big"
      ? []
      : [
          { task: "short-answer", seconds: round(150 / tokensPerSecond) },
          { task: "long-answer", seconds: round(1000 / tokensPerSecond) },
          { task: "read-file", seconds: round(3000 / prefillPerSecond) },
          { task: "load", seconds: round(sizeGb / diskGbPerSecond + 2) },
        ];
  return {
    rating,
    fit,
    tokensPerSecond: round(tokensPerSecond),
    wordsPerSecond: round(tokensPerSecond * 0.75),
    gpuShare: round(gpuShare),
    tasks,
  };
}

let cached: { at: number; info: Promise<HardwareInfo> } | undefined;

/**
 * {@link detectHardware}, cached for a minute so lists that rate many
 * models do not run nvidia-smi for each one.
 *
 * @returns Hardware summary.
 */
export function detectHardwareCached(): Promise<HardwareInfo> {
  if (!cached || Date.now() - cached.at > 60_000) cached = { at: Date.now(), info: detectHardware() };
  return cached.info;
}
