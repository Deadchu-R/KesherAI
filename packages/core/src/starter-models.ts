/**
 * The welcome's hardware check: which 1–3 chat models to offer a new user, from the "Start here" list, marked with
 * the same run marks as the Hugging Face search (fully on the graphics card / partly / too big; @kesher/downloads fit).
 */
import { estimateRunFit, type MemoryBudget, type RunFit } from "@kesher/downloads";
import type { RecommendedModel } from "@kesher/shared";

const GB = 1024 ** 3;

/** Roles that write code: they get a model that handles tools well. */
const CODE_ROLES = ["developer", "gamedev"];
/** Roles that mostly read and write text: Hebrew speakers among them get Dicta's Hebrew model. */
const TEXT_ROLES = ["writer", "student", "researcher", "everyday", "business", "youtuber", "other"];
const HEBREW_MODEL = "dictalm-12b";

/** One model the welcome offers, with its run mark and why it was picked. */
export interface StarterPick {
  id: string;
  fit: RunFit;
  /** Share of the model on the graphics card, 0–1. */
  gpuShare: number;
  why: "best" | "fast" | "hebrew";
}

/**
 * Picks up to three starter models for this computer: the strongest that runs fully on the graphics card (one good
 * at tools for coders; if none fits fully, the smallest that runs partly), Dicta's Hebrew model for Hebrew speakers
 * who mostly write, and the smallest quick one. Models too big for this computer are never offered.
 *
 * @param models - The "Start here" list (RECOMMENDED_MODELS).
 * @param budget - This computer's memory (budgetOf).
 * @param opts - The picked roles and whether the interface is in Hebrew.
 * @returns The picks, most recommended first; empty when nothing runs here.
 */
export function pickStarterModels(models: readonly RecommendedModel[], budget: MemoryBudget, opts: { roles: string[]; hebrew: boolean }): StarterPick[] {
  const marked = models.map((m) => ({ m, ...estimateRunFit(m.sizeGb * GB, budget, { kind: "llm" }) }));
  const usable = marked.filter((x) => x.fit === "gpu" || x.fit === "partial").sort((a, b) => a.m.sizeGb - b.m.sizeGb);
  if (!usable.length) return [];
  const code = opts.roles.some((r) => CODE_ROLES.includes(r));
  const general = usable.filter((x) => x.m.id !== HEBREW_MODEL);
  const wanted = code ? general.filter((x) => x.m.goodForCode) : general;
  const pool = wanted.length ? wanted : general.length ? general : usable;
  const onGpu = pool.filter((x) => x.fit === "gpu");
  const best = onGpu.length ? onGpu[onGpu.length - 1]! : pool[0]!;
  const picks: StarterPick[] = [{ id: best.m.id, fit: best.fit, gpuShare: best.gpuShare, why: "best" }];
  const textRole = !opts.roles.length || opts.roles.some((r) => TEXT_ROLES.includes(r));
  const hebrew = usable.find((x) => x.m.id === HEBREW_MODEL);
  if (opts.hebrew && textRole && hebrew && hebrew.m.id !== best.m.id) picks.push({ id: hebrew.m.id, fit: hebrew.fit, gpuShare: hebrew.gpuShare, why: "hebrew" });
  const fast = general[0] ?? usable[0]!;
  if (!picks.some((p) => p.id === fast.m.id)) picks.push({ id: fast.m.id, fit: fast.fit, gpuShare: fast.gpuShare, why: "fast" });
  return picks.slice(0, 3);
}
