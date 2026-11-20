import type { HelperPlanRef, HelperRunInfo } from "@kesher/shared";

/**
 * The chat's Plan cards from its helper runs (docs/RESEARCH_LOG.md, "Gap list: agents and chat-first", A15 and A16;
 * design boards PlanCard and PhonePlanSheet): the runs of one plan grouped, the plan as its newest revision has it,
 * where its card goes in the thread (the first delegate or deep_research call), and its stage.
 */

/** Where a plan is, for its card. */
export type PlanStage = "running" | "writing" | "done" | "failed" | "stopped";

/** One plan, as its card shows it. */
export interface PlanView {
  plan: HelperPlanRef;
  /** Its sub-agents, in the order they were started (removed ones too, struck through). */
  runs: HelperRunInfo[];
  /** The call whose step the card follows in the thread (its first run's). */
  callId?: string;
  stage: PlanStage;
  /** Counts over the sub-agents still on the plan. */
  going: number;
  done: number;
  failed: number;
  stopped: number;
  /** When its first sub-agent started and its last one ended (for the summary's time). */
  startedAt?: number;
  endedAt?: number;
}

const isGoing = (r: HelperRunInfo) => r.state === "waiting" || r.state === "asking" || r.state === "running";

/**
 * Groups a chat's runs into plans.
 *
 * @param runs - The chat's runs (the `helpers` event).
 * @returns One view per plan, oldest first; runs without a plan are left out.
 */
export function plansOf(runs: HelperRunInfo[]): PlanView[] {
  const by = new Map<string, HelperRunInfo[]>();
  for (const r of runs) if (r.plan) by.set(r.plan.id, [...(by.get(r.plan.id) ?? []), r]);
  return [...by.values()]
    .map((list) => {
      const sorted = [...list].sort((a, b) => a.queuedAt - b.queuedAt);
      // Every run carries the plan; a revision reaches all of them, so the highest `rev` is the newest.
      const plan = sorted.reduce((p, r) => ((r.plan!.rev ?? 0) >= (p.rev ?? 0) ? r.plan! : p), sorted[0]!.plan!);
      const on = sorted.filter((r) => !r.removed);
      const going = on.filter(isGoing).length;
      const done = on.filter((r) => r.state === "done").length;
      const failed = on.filter((r) => r.state === "failed").length;
      const stopped = on.filter((r) => r.state === "stopped").length;
      const starts = sorted.flatMap((r) => (r.startedAt ? [r.startedAt] : []));
      const ends = sorted.flatMap((r) => (r.endedAt ? [r.endedAt] : []));
      const callId = sorted.find((r) => r.callId)?.callId;
      return {
        plan,
        runs: sorted,
        ...(callId ? { callId } : {}),
        stage: stageOf(plan, going, done, failed, on.length),
        going,
        done,
        failed,
        stopped,
        ...(starts.length ? { startedAt: Math.min(...starts) } : {}),
        ...(ends.length && !going ? { endedAt: Math.max(...ends) } : {}),
      };
    })
    .sort((a, b) => a.runs[0]!.queuedAt - b.runs[0]!.queuedAt);
}

/** A plan's stage from its sub-agents (and a deep research's own stage). */
function stageOf(plan: HelperPlanRef, going: number, done: number, failed: number, on: number): PlanStage {
  if (going) return "running";
  if (plan.kind === "research") {
    if (plan.phase === "writing") return "writing";
    if (plan.phase === "done") return "done";
    if (plan.phase === "failed") return "failed";
    // Still "researching" with nothing going: the chat's Stop or a restart ended it before the report.
    return "stopped";
  }
  if (done) return "done";
  if (failed && failed === on) return "failed";
  return "stopped";
}

/**
 * @returns Whether the card shows only its one-line summary by default (everything ended).
 * @param v - The plan.
 */
export const planCollapsed = (v: PlanView): boolean => v.stage !== "running" && v.stage !== "writing";
