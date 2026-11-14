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
  /** Why there is no plan, from llama.cpp's own words (e.g. a model this build does not know). */
  error?: string;
  /** System memory the plan needs (model parts, context and compute kept there), in MiB. */
  hostMiB?: number;
}

/**
 * Reads `llama-fit-params --fit-print on`: one line per card and one "Host" line, each "name model context compute"
 * in MiB.
 *
 * @param stdout - What it printed.
 * @returns The system memory needed (MiB), when it says.
 */
export function parseFitPrint(stdout: string): { hostMiB?: number } {
  const m = /^Host\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(stdout);
  return m ? { hostMiB: Number(m[1]) + Number(m[2]) + Number(m[3]) } : {};
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
  // b12110+ adds "(N overflowing)" for a MoE model's layers that are partly in system memory.
  for (const m of flat.matchAll(/-\s+([A-Za-z]+\d+)\s+\(([^)]+)\):\s+(\d+)\s+layers(?:\s+\(\s*\d+\s+overflowing\))?,\s+(\d+)\s+MiB used,\s+(-?\d+)\s+MiB free/g)) {
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
  // llama-fit-params prints the arguments only when it fits (it exits with "failed to fit" otherwise); b12110 logs
  // "successfully fit params" only at trace level, so the printed arguments are the sign.
  const ok = (/successfully fit params/i.test(flat) || args.length > 0) && !/failed to fit/i.test(flat);
  // No plan at all: say why (the first error line, without llama.cpp's timestamp and level).
  const errLine = !ok && !args.length ? flat.split("\n").find((l) => /unknown model architecture|failed to load|error/i.test(l)) : undefined;
  const error = errLine?.replace(/^[\d.]+\s+[IWE]\s+/, "").trim().slice(0, 300);
  return {
    ok,
    devices,
    ...(nLayer ? { totalLayers: nLayer + 1 } : {}),
    gpuLayers,
    ...(Number.isFinite(ctx) ? { context: ctx } : {}),
    inSystemMemory: args.some((a) => a === "-ot" || a === "--override-tensor" || a === "-ncmoe" || a === "--n-cpu-moe" || a === "-cmoe" || a === "--cpu-moe"),
    args,
    ms,
    ...(error ? { error } : {}),
  };
}
