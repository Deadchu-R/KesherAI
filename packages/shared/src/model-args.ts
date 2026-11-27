/**
 * Load settings for one model (as LM Studio keeps them per model): its context size, the context memory's type, how
 * many expert layers stay on the processor, flash attention, and more llama-server arguments. Saved per model file
 * and added each time that file loads; a setting here replaces the same one from the engine's own arguments.
 */
export interface ModelLoadSettings {
  /** Context window in tokens (`-c`). */
  ctx?: number;
  /** The context memory's type (`--cache-type-k/v`). */
  kv?: "f16" | "q8_0" | "q4_0";
  /** Mixture-of-experts layers kept on the processor (`--n-cpu-moe`). */
  cpuMoe?: number;
  /** Flash attention (`-fa on|off`). */
  flash?: "on" | "off";
  /** More arguments, from the allowed list below. */
  extra?: string[];
  /** True: no sampling preset for this model (sampling-presets.ts); llama.cpp's own defaults apply. */
  samplingOff?: boolean;
}

/**
 * The llama-server arguments a model's settings may hold, each with its other spellings, and whether it takes a value.
 * Only loading and sampling: nothing that names a file, a port, an address or a key (a phone connected to the
 * computer can change these settings, so they must not reach the disk or the network).
 */
const FLAGS: Array<{ names: string[]; value: boolean }> = [
  { names: ["-c", "--ctx-size"], value: true },
  { names: ["-ngl", "--n-gpu-layers", "--gpu-layers"], value: true },
  { names: ["-t", "--threads"], value: true },
  { names: ["-tb", "--threads-batch"], value: true },
  { names: ["-b", "--batch-size"], value: true },
  { names: ["-ub", "--ubatch-size"], value: true },
  { names: ["-ctk", "--cache-type-k"], value: true },
  { names: ["-ctv", "--cache-type-v"], value: true },
  { names: ["-fa", "--flash-attn"], value: true },
  { names: ["-ncmoe", "--n-cpu-moe"], value: true },
  { names: ["-ot", "--override-tensor"], value: true },
  { names: ["-sm", "--split-mode"], value: true },
  { names: ["-ts", "--tensor-split"], value: true },
  { names: ["-mg", "--main-gpu"], value: true },
  { names: ["--temp"], value: true },
  { names: ["--top-k"], value: true },
  { names: ["--top-p"], value: true },
  { names: ["--min-p"], value: true },
  { names: ["--repeat-penalty"], value: true },
  { names: ["--presence-penalty"], value: true },
  { names: ["--frequency-penalty"], value: true },
  { names: ["--seed"], value: true },
  { names: ["-n", "--n-predict"], value: true },
  { names: ["--rope-scaling"], value: true },
  { names: ["--rope-freq-base"], value: true },
  { names: ["--rope-freq-scale"], value: true },
  { names: ["--yarn-orig-ctx"], value: true },
  { names: ["--reasoning-budget"], value: true },
  { names: ["--reasoning-format"], value: true },
  { names: ["--draft-max"], value: true },
  { names: ["--draft-min"], value: true },
  { names: ["--no-mmap"], value: false },
  { names: ["--mlock"], value: false },
  { names: ["-nkvo", "--no-kv-offload"], value: false },
  { names: ["--swa-full"], value: false },
  { names: ["--no-context-shift"], value: false },
  { names: ["--context-shift"], value: false },
  { names: ["--no-warmup"], value: false },
];
const BY_NAME = new Map(FLAGS.flatMap((f) => f.names.map((n) => [n, f] as const)));

/**
 * Splits typed arguments at spaces; quotes keep a value with spaces together.
 *
 * @param text - Say `--temp 0.7 -ot "exps=CPU"`.
 * @returns The arguments.
 */
export function splitEngineArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

/**
 * Checks more arguments against the allowed list.
 *
 * @param args - The arguments.
 * @returns `undefined` when they are fine, else what is wrong, in words.
 */
export function checkExtraArgs(args: readonly string[]): string | undefined {
  if (args.length > 40) return "Too many arguments (at most 40).";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const f = BY_NAME.get(a);
    if (!f) return `${a.slice(0, 40)} is not one of the load or sampling settings KesherAI allows here.`;
    if (!f.value) continue;
    const v = args[++i];
    if (v === undefined || (v.startsWith("-") && !/^-\d/.test(v))) return `${a} needs a value.`;
    if (v.length > 200 || /[\r\n\0]/.test(v)) return `The value of ${a} is too long.`;
  }
  return undefined;
}

/**
 * Checks a model's settings as they came from the page.
 *
 * @param s - The settings.
 * @returns `undefined` when they are fine, else what is wrong.
 */
export function checkLoadSettings(s: ModelLoadSettings): string | undefined {
  if (s.ctx !== undefined && (!Number.isInteger(s.ctx) || s.ctx < 512 || s.ctx > 4_194_304)) return "Context: 512 to 4,194,304 tokens.";
  if (s.kv !== undefined && !["f16", "q8_0", "q4_0"].includes(s.kv)) return "Context memory: f16, q8_0 or q4_0.";
  if (s.cpuMoe !== undefined && (!Number.isInteger(s.cpuMoe) || s.cpuMoe < 0 || s.cpuMoe > 512)) return "Expert layers on the processor: 0 to 512.";
  if (s.flash !== undefined && s.flash !== "on" && s.flash !== "off") return "Flash attention: on or off.";
  return s.extra ? checkExtraArgs(s.extra) : undefined;
}

/**
 * A model's settings as llama-server arguments.
 *
 * @param s - The settings.
 * @returns The arguments (empty when nothing is set).
 */
export function loadSettingsArgs(s: ModelLoadSettings | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  if (s.ctx) out.push("-c", String(s.ctx));
  if (s.kv) out.push("--cache-type-k", s.kv, "--cache-type-v", s.kv);
  if (s.cpuMoe !== undefined) out.push("--n-cpu-moe", String(s.cpuMoe));
  if (s.flash) out.push("-fa", s.flash);
  return [...out, ...(s.extra ?? [])];
}

/**
 * The engine's arguments with a model's own on top: a setting the model has replaces the same one (under any of its
 * spellings) from the engine's arguments.
 *
 * @param engine - The engine's arguments (config).
 * @param model - The model's arguments (loadSettingsArgs).
 * @returns The arguments to load with.
 */
export function withModelArgs(engine: readonly string[], model: readonly string[]): string[] {
  if (!model.length) return [...engine];
  const set = new Set(model.filter((a) => BY_NAME.has(a)).flatMap((a) => BY_NAME.get(a)!.names));
  const kept: string[] = [];
  for (let i = 0; i < engine.length; i++) {
    const a = engine[i]!;
    const known = BY_NAME.get(a);
    const takesValue = known ? known.value : engine[i + 1] !== undefined && !engine[i + 1]!.startsWith("-");
    if (set.has(a)) {
      if (takesValue) i++;
      continue;
    }
    kept.push(a);
  }
  return [...kept, ...model];
}
