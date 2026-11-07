import { execFile } from "node:child_process";
import { freemem, totalmem, platform, cpus } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

/** What the machine has, as far as Kesher can tell. */
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
