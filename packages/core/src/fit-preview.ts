/**
 * What llama.cpp will do with a model before it is loaded (docs/VISION.md, "Engine memory, visible"):
 * llama-fit-params runs the same fitting llama-server does at start (test allocations, no weights read) and
 * says how many layers go on each graphics card, how much memory that takes, and what is left. It reads the
 * free memory as it is now, so it also tells when a model will not fit next to what is already loaded.
 */

/** One graphics card in the plan. */
export interface FitDevice {
  name: string;
  /** Layers on this card. */
  layers: number;
  usedMiB: number;
  /** Left free on the card after loading. */
  freeMiB: number;
}

/** The plan for one model. */
export interface FitPlan {
  /** Whether it fits in the free memory (with the margin kept free). */
  ok: boolean;
  devices: FitDevice[];
  /** Layers in the model (with the output layer), when the log says. */
  totalLayers?: number;
  /** Layers on the graphics cards together. */
  gpuLayers: number;
  /** Context per the plan (tokens), when it sets one. */
  context?: number;
  /** Parts kept in system memory (tensor overrides, e.g. a MoE model's experts). */
  inSystemMemory: boolean;
  /** The arguments llama.cpp chose. */
  args: string[];
  /** How long the check took. */
  ms: number;
}

/**
 * Reads llama-fit-params' output.
 *
 * @param log - What it wrote to stderr (its log).
 * @param stdout - The fitted arguments it printed (e.g. "-c 49152 -ngl 60").
 * @param ms - How long it took.
 * @returns The plan.
 */
export function parseFit(log: string, stdout: string, ms: number): FitPlan {
  const devices: FitDevice[] = [];
  // "  - CUDA0 (NVIDIA GeForce RTX 3090): 60 layers,  16727 MiB used,   1237 MiB free"
  const flat = log.replace(/\r/g, "");
  for (const m of flat.matchAll(/-\s+([A-Za-z]+\d+)\s+\(([^)]+)\):\s+(\d+)\s+layers,\s+(\d+)\s+MiB used,\s+(-?\d+)\s+MiB free/g)) {
    devices.push({ name: `${m[2]!.trim()} (${m[1]})`, layers: Number(m[3]), usedMiB: Number(m[4]), freeMiB: Number(m[5]) });
  }
  const args = stdout.trim().split(/\s+/).filter(Boolean);
  const arg = (...names: string[]) => {
    const i = args.findIndex((a) => names.includes(a));
    return i >= 0 ? args[i + 1] : undefined;
  };
  const nLayer = Number(/n_layer\s*=\s*(\d+)/.exec(flat)?.[1] ?? 0);
  const ngl = Number(arg("-ngl", "--n-gpu-layers", "--gpu-layers") ?? NaN);
  const gpuLayers = devices.length ? devices.reduce((n, d) => n + d.layers, 0) : Number.isFinite(ngl) ? ngl : 0;
  const ctx = Number(arg("-c", "--ctx-size") ?? NaN);
  const ok = /successfully fit params/i.test(flat) && !/failed to fit/i.test(flat);
  return {
    ok,
    devices,
    ...(nLayer ? { totalLayers: nLayer + 1 } : {}),
    gpuLayers,
    ...(Number.isFinite(ctx) ? { context: ctx } : {}),
    inSystemMemory: args.some((a) => a === "-ot" || a === "--override-tensor" || a === "-ncmoe" || a === "--n-cpu-moe" || a === "-cmoe" || a === "--cpu-moe"),
    args,
    ms,
  };
}
