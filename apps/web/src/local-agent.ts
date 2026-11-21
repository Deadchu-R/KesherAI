/**
 * The local agent (self-work) as the task screens see it: whether it works now, and the request that starts it again
 * with the last run's project and check (never started silently: the user taps Start).
 */

/** The part of a self-work run (GET /api/self-work) these screens read. */
export interface LocalAgentRun {
  repo: string;
  goal: string;
  check: string;
  status: "running" | "waiting" | "done" | "blocked" | "stopped" | "failed";
}

/** What the notice shows: working, off with a run to start again, or off and never run on this computer. */
export type LocalAgentState = "on" | "off-restart" | "off-setup";

/**
 * @param run - The last self-work run (`run` of GET /api/self-work), or null when there was none.
 * @returns "on" while it runs or waits for approval; "off-restart" when a Start can reuse the last run's project;
 *   "off-setup" when there is no earlier run (the user chooses the project on the Self-work page).
 */
export function localAgentState(run: LocalAgentRun | null | undefined): LocalAgentState {
  if (run && (run.status === "running" || run.status === "waiting")) return "on";
  return run?.repo && run.check !== undefined ? "off-restart" : "off-setup";
}

/**
 * The body of POST /api/self-work/start for "start again": the last run's project, goal and check. The phone is
 * allowed to start only with the same project and check, so nothing else is changed here.
 *
 * @param run - The last run.
 * @param hours - How long to work (default 2, as the Self-work page).
 */
export function restartBody(run: LocalAgentRun, hours = 2): { repo: string; goal: string; check: string; hours: number } {
  return { repo: run.repo, goal: run.goal, check: run.check, hours };
}
