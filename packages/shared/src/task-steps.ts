/**
 * A step estimate for a task-inbox task ("~N steps"), made when the task is queued from the task itself: no model
 * call, one small formula. It is a guide for the progress line ("step 4 of ~11"), not a promise: the real count is
 * whatever the agent does, and the line keeps counting past the estimate.
 */

/** What the estimate needs from a task (a subset of an inbox task, so the hub page and the PC card share it). */
export interface StepEstimateInput {
  /** Who runs it after routing. */
  runBy: "antigravity" | "local" | "opus" | "gemini" | "opencode";
  /** `research` tasks are estimated by their parts; anything else is code work. */
  kind?: string;
  /** The most files the task may touch. */
  maxFiles: number;
  goal: string;
  /** The check KesherAI runs after the work (empty: none). */
  check: string;
  /** The acceptance text: a research task's parts are its list items. */
  acceptance?: string;
  /** The run's plan steps, when the run came with one: then the estimate is the plan's length. */
  plan?: readonly { content: string; status: string }[] | null;
}

/** The free-Gemini route plans at most this many parts (the same limit as the research runner). */
export const GEMINI_MAX_PARTS = 3;
/** A big research task (Antigravity, Claude) is counted up to this many parts. */
export const BIG_MAX_PARTS = 8;
/** An estimate is never below this nor above {@link MAX_STEPS}. */
export const MIN_STEPS = 3;
export const MAX_STEPS = 60;
/** With a plan the plan is the estimate (one step per item), capped here so every line shows the same number. */
export const PLAN_MAX_STEPS = 40;

/**
 * The parts of a research task: the list items of its acceptance text (`- x`, `* x`, `1. x`), at least one.
 *
 * @param acceptance - The task's acceptance text.
 * @returns How many parts.
 */
export function researchParts(acceptance: string | undefined): number {
  const items = (acceptance ?? "").split("\n").filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l)).length;
  return Math.max(1, items);
}

/**
 * Estimates how many agent steps a task takes.
 *
 * - A plan: the run's own plan, one step per item (at most {@link PLAN_MAX_STEPS}), so the hub line, the PC card and
 *   the in-run line all count the same thing; the formulas below are only the fallback for a task without a plan.
 * - Research: parts x (search + read) + 1 to write the report. The free-Gemini route plans at most
 *   {@link GEMINI_MAX_PARTS} parts; a big research task counts up to {@link BIG_MAX_PARTS}.
 * - Code (Antigravity, the local model, Claude): 3 (look around, plan, wrap up) + about one step per file the task may
 *   touch (at most 15) + one per 400 characters of goal + 2 when there is a check to run and fix.
 *
 * @param t - The task's own fields.
 * @returns A whole number between {@link MIN_STEPS} and {@link MAX_STEPS} (1 to {@link PLAN_MAX_STEPS} with a plan).
 */
export function estimateTaskSteps(t: StepEstimateInput): number {
  if (t.plan && t.plan.length > 0) return Math.min(PLAN_MAX_STEPS, t.plan.length);
  let n: number;
  if (t.kind === "research") {
    const parts = Math.min(researchParts(t.acceptance), t.runBy === "gemini" ? GEMINI_MAX_PARTS : BIG_MAX_PARTS);
    n = parts * 2 + 1;
  } else {
    n = 3 + Math.min(Math.max(t.maxFiles, 1), 15) + Math.ceil(t.goal.length / 400) + (t.check.trim() ? 2 : 0);
  }
  return Math.min(MAX_STEPS, Math.max(MIN_STEPS, Math.round(n)));
}
