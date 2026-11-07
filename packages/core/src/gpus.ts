/**
 * Using every graphics card well, including two of different generations
 * (say an RTX 3090 and a newer card).
 *
 * llama.cpp splits a model's layers across cards (`--tensor-split`), and the
 * card named by `--main-gpu` holds the small shared parts and does the work
 * between layers, so it should be the fastest. Splitting costs time on the
 * PCIe bus, so when a model fits on the fastest card alone with room to
 * spare, it is faster to use only that card. A mixed pair is limited by the
 * slower card for the layers it holds, so the split follows each card's
 * free memory (to fit the most) unless the user sets the shares.
 *
 * GPUs are numbered in PCI bus order, as `nvidia-smi` lists them, and CUDA is
 * told to use the same order (`CUDA_DEVICE_ORDER=PCI_BUS_ID`), so the
 * numbers match everywhere.
 */

/** One NVIDIA card, as detected. */
export interface Gpu {
  index: number;
  name: string;
  vramTotal: number;
  vramFree: number;
  computeCap?: number;
}

/** The user's choice (config `engines.gpus`). */
export interface GpuPrefs {
  /** `auto`: the fastest card alone when the model fits it, else all; `fastest`: always one card; `all`: always split. */
  mode: "auto" | "fastest" | "all";
  /** Card indices to use (default: all). */
  use?: number[];
  /** Shares per used card, in the order of `use` (default: by free memory). */
  split?: number[];
  /** The card that leads (default: the fastest). */
  main?: number;
}

/** What to start an engine with. */
export interface GpuPlan {
  /** Extra llama-server arguments. */
  args: string[];
  /** Environment for the engine process. */
  env: Record<string, string>;
  /** The cards used, leader first. */
  cards: number[];
  /** Each used card's share in percent, in PCI order (one card: 100). */
  parts: Array<{ index: number; share: number }>;
  /** One line for the user, e.g. "Split across RTX 4090 (60%) and RTX 3090 (40%)". */
  summary: string;
}

/** Rough speed per compute capability, for picking the leader when nothing else is known. */
function speedOf(g: Gpu): number {
  const cap = g.computeCap ?? (/\b50\d0\b/.test(g.name) ? 12 : /\b40\d0\b/.test(g.name) ? 8.9 : /\b30\d0\b/.test(g.name) ? 8.6 : /\b20\d0\b/.test(g.name) ? 7.5 : 6);
  return cap * 1000 + g.vramTotal / 1024 ** 3;
}

/**
 * @param gpus - Detected NVIDIA cards.
 * @returns The fastest card first.
 */
export function bySpeed(gpus: readonly Gpu[]): Gpu[] {
  return [...gpus].sort((a, b) => speedOf(b) - speedOf(a));
}

/**
 * Plans how llama.cpp uses the cards for one model.
 *
 * @param gpus - Detected NVIDIA cards.
 * @param prefs - The user's choice.
 * @param modelBytes - Size of the model file(s), to see if one card is enough.
 * @param contextBytes - Room for the context and work buffers (default 2.5 GB).
 * @returns Arguments and environment; empty for zero or one card.
 */
export function planGpus(gpus: readonly Gpu[], prefs: GpuPrefs, modelBytes = 0, contextBytes = 2.5 * 1024 ** 3): GpuPlan {
  const env: Record<string, string> = { CUDA_DEVICE_ORDER: "PCI_BUS_ID" };
  const pool = gpus.filter((g) => !prefs.use || prefs.use.includes(g.index)).sort((a, b) => a.index - b.index);
  if (pool.length === 0) return { args: [], env: {}, cards: [], parts: [], summary: "" };
  const leader = pool.find((g) => g.index === prefs.main) ?? bySpeed(pool)[0]!;
  const fitsLeader = modelBytes > 0 && modelBytes + contextBytes <= leader.vramFree * 0.92;
  const single = pool.length === 1 || prefs.mode === "fastest" || (prefs.mode === "auto" && fitsLeader);
  if (single) {
    env.CUDA_VISIBLE_DEVICES = String(leader.index);
    return {
      args: [],
      env,
      cards: [leader.index],
      parts: [{ index: leader.index, share: 100 }],
      summary: pool.length > 1 ? `Using ${leader.name} only (the model fits on it, which is faster than splitting)` : `Using ${leader.name}`,
    };
  }
  env.CUDA_VISIBLE_DEVICES = pool.map((g) => g.index).join(",");
  const raw = prefs.split && prefs.split.length === pool.length && prefs.split.every((x) => x > 0) ? prefs.split : pool.map((g) => Math.max(1, g.vramFree));
  const total = raw.reduce((a, b) => a + b, 0);
  const shares = raw.map((x) => Math.round((x / total) * 100));
  const mainPos = pool.findIndex((g) => g.index === leader.index);
  return {
    args: ["--split-mode", "layer", "--tensor-split", shares.join(","), "--main-gpu", String(mainPos)],
    env,
    cards: [leader.index, ...pool.filter((g) => g.index !== leader.index).map((g) => g.index)],
    parts: pool.map((g, i) => ({ index: g.index, share: shares[i]! })),
    summary: `Split across ${pool.map((g, i) => `${g.name} (${shares[i]}%)`).join(" and ")}; ${leader.name} leads`,
  };
}

/**
 * Whether the user's own llama-server arguments already choose the cards,
 * in which case KesherAI adds nothing.
 *
 * @param args - Arguments from the config.
 * @returns `true` if they set the split or the main card.
 */
export function userChoseGpus(args: readonly string[]): boolean {
  return args.some((a) => /^(--tensor-split|-ts|--main-gpu|-mg|--split-mode|-sm|--device|-dev)$/.test(a));
}
