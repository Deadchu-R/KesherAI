import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
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
  /**
   * One entry per NVIDIA GPU found through `nvidia-smi`, in PCI bus order
   * (the order CUDA uses when `CUDA_DEVICE_ORDER=PCI_BUS_ID`); empty otherwise.
   * `computeCap` is the CUDA compute capability (8.6 = RTX 30, 8.9 = RTX 40,
   * 12.0 = RTX 50); newer drivers report it.
   */
  gpus: Array<{ name: string; vramTotal: number; vramFree: number; index?: number; computeCap?: number; vendor?: GpuVendor }>;
  /**
   * On Apple Silicon, GPU and CPU share memory, so RAM is also the model budget.
   */
  unifiedMemory: boolean;
}

/** Who made a graphics card (NVIDIA cards run on CUDA; AMD and Intel on Vulkan). */
export type GpuVendor = "nvidia" | "amd" | "intel";

const PCI_VENDORS: Record<string, GpuVendor> = { "0x1002": "amd", "0x8086": "intel", "0x10de": "nvidia" };

/**
 * AMD and Intel cards on Linux, from the kernel's own view (`/sys/class/drm`): the amdgpu driver reports the
 * card's memory there, with no tool to install. The name comes from `lspci` when it is there.
 *
 * @param root - The sysfs folder (tests pass their own).
 * @returns The cards found (no NVIDIA: nvidia-smi reports those).
 */
export async function linuxGpus(root = "/sys/class/drm"): Promise<HardwareInfo["gpus"]> {
  const out: HardwareInfo["gpus"] = [];
  const seen = new Set<string>();
  for (const card of (await readdir(root).catch(() => [] as string[])).filter((n) => /^card\d+$/.test(n)).sort()) {
    const dev = join(root, card, "device");
    const vendor = PCI_VENDORS[(await readFile(join(dev, "vendor"), "utf8").catch(() => "")).trim()];
    if (!vendor || vendor === "nvidia") continue;
    // The PCI address (0000:03:00.0): one card can show as two "cardN" entries.
    const real = basename(await realpath(dev).catch(() => dev));
    const slot = /^[\da-f]{4}:[\da-f]{2}:[\da-f]{2}\.\d$/i.test(real) ? real : card;
    if (seen.has(slot)) continue;
    seen.add(slot);
    const num = async (f: string) => Number((await readFile(join(dev, f), "utf8").catch(() => "")).trim()) || 0;
    const total = await num("mem_info_vram_total");
    const used = await num("mem_info_vram_used");
    let name = (await readFile(join(dev, "product_name"), "utf8").catch(() => "")).trim();
    if (!name) {
      const { stdout } = slot === card ? { stdout: "" } : await run("lspci", ["-vmm", "-s", slot], { timeout: 2000 }).catch(() => ({ stdout: "" }));
      name = /^Device:\s*(.+)$/m.exec(stdout)?.[1]?.trim() ?? "";
    }
    if (!name) name = vendor === "amd" ? "AMD Radeon" : "Intel graphics";
    else if (vendor === "amd" && !/amd|radeon/i.test(name)) name = `AMD ${name}`;
    else if (vendor === "intel" && !/intel/i.test(name)) name = `Intel ${name}`;
    // Intel's built-in graphics report no memory of their own: they share the computer's RAM.
    out.push({ name, vramTotal: total, vramFree: Math.max(0, total - used), vendor });
  }
  return out;
}

/** AMD and Intel cards on Windows, from the display driver's registry entries (their real memory size). */
async function windowsGpus(): Promise<HardwareInfo["gpus"]> {
  const script =
    "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | " +
    "ForEach-Object { '{0}|{1}|{2}' -f $_.DriverDesc, $_.'HardwareInformation.qwMemorySize', $_.MatchingDeviceId }";
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 5000, windowsHide: true }).catch(() => ({ stdout: "" }));
  const out: HardwareInfo["gpus"] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [name = "", mem = "", id = ""] = line.split("|").map((x) => x.trim());
    const vendor = /ven_1002/i.test(id) ? "amd" : /ven_8086/i.test(id) ? "intel" : undefined;
    if (!vendor || !name) continue;
    const total = Number(mem) || 0;
    out.push({ name, vramTotal: total, vramFree: total, vendor });
  }
  return out;
}

/**
 * Detects RAM and graphics cards: NVIDIA through `nvidia-smi`; AMD and Intel through the kernel (Linux) or the
 * driver's registry entries (Windows). Never throws: what cannot be read is left out.
 *
 * @returns Hardware summary.
 */
export async function detectHardware(): Promise<HardwareInfo> {
  const gpus: HardwareInfo["gpus"] = [];
  for (const fields of ["index,name,memory.total,memory.free,compute_cap", "index,name,memory.total,memory.free"]) {
    try {
      const { stdout } = await run("nvidia-smi", [`--query-gpu=${fields}`, "--format=csv,noheader,nounits"], { timeout: 3000 });
      for (const line of stdout.trim().split("\n")) {
        const [index, name, total, free, cap] = line.split(",").map((s) => s.trim());
        if (name && total && free) {
          // DGX Spark (GB10) and other unified-memory machines report "[N/A]": the card uses the computer's RAM.
          const shared = Number.isNaN(Number(total));
          gpus.push({
            name,
            vramTotal: shared ? totalmem() : Number(total) * 1024 ** 2,
            vramFree: shared ? freemem() : Number(free) * 1024 ** 2,
            ...(index && /^\d+$/.test(index) ? { index: Number(index) } : {}),
            ...(cap && !Number.isNaN(Number(cap)) ? { computeCap: Number(cap) } : {}),
          });
        }
      }
      break;
    } catch {
      // Older drivers do not know compute_cap: try without it. No driver at all: no GPUs.
    }
  }
  for (const g of gpus) g.vendor = "nvidia";
  // AMD and Intel: after NVIDIA, so CUDA's card numbers stay as they are.
  if (platform() === "linux") gpus.push(...(await linuxGpus().catch(() => [])));
  else if (platform() === "win32") gpus.push(...(await windowsGpus().catch(() => [])));
  const cpu = cpus()[0]?.model ?? "unknown";
  return {
    platform: platform(),
    cpu,
    ramTotal: totalmem(),
    ramFree: freemem(),
    gpus,
    unifiedMemory: (platform() === "darwin" && /Apple/i.test(cpu)) || gpus.some((g) => /GB10|Grace|Spark/i.test(g.name)),
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
  [/GB10|Spark/i, 273], [/A100/, 1555], [/H100/, 3350], [/L40/, 864], [/A6000/, 768], [/A4000/, 448],
  // AMD Radeon.
  [/9070 XT/i, 640], [/9070/, 640], [/9060 XT/i, 322], [/7900 XTX/i, 960], [/7900 XT/i, 800], [/7900 GRE/i, 576], [/7800 XT/i, 624],
  [/7700 XT/i, 432], [/7600 XT/i, 288], [/7600/, 288], [/6950 XT/i, 576], [/6900 XT/i, 512], [/6800 XT/i, 512], [/6800/, 512],
  [/6750 XT/i, 432], [/6700 XT/i, 384], [/6700/, 320], [/6650 XT/i, 280], [/6600 XT/i, 256], [/6600/, 224], [/6500 XT/i, 144],
  [/5700 XT/i, 448], [/5700/, 448], [/5600 XT/i, 288], [/Radeon VII/i, 1024], [/Vega 64/i, 484], [/Vega 56/i, 410],
  [/MI300/i, 5300], [/MI250/i, 3200], [/W7900/i, 864], [/W7800/i, 576],
  // Intel Arc.
  [/B580/, 456], [/B570/, 380], [/A770/, 560], [/A750/, 512], [/A580/, 512], [/A380/, 186],
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
  if (hw.unifiedMemory) return hw.gpus.some((g) => /GB10|Spark/i.test(g.name)) ? 273 : appleBandwidth(hw.cpu);
  const best = [...hw.gpus].sort((a, b) => b.vramTotal - a.vramTotal)[0];
  // Built-in graphics with little or no memory of their own are no faster than the processor.
  if (!best || best.vramTotal < 2 * 1024 ** 3) return 0;
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
