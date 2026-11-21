/**
 * Pure helpers of the live view of browser and computer control (ControlLive.tsx), kept apart so they can be tested
 * without a browser.
 */

/** Which picture the live view shows: KesherAI's browser pane, the user's Chrome tab, or the computer's screen. */
export type LiveSource = "pane" | "chrome" | "computer";

/** What the live view reads from `/api/control/live` (routes/browser.ts). */
export interface LiveState {
  paused: boolean;
  mode: "manual" | "auto" | "skip";
  skipAllowed: boolean;
  browser: { active: boolean; pane: boolean; chrome?: string };
  computer: { enabled: boolean; active: boolean; app: string };
  log: Array<{ at: string; kind: "browser" | "computer"; action: string; where?: string; target?: string; ok: boolean; note?: string }>;
  approvals: Array<{ conversationId: string; title: string; ev: unknown }>;
}

/**
 * The pictures that can be shown now, in the tabs' order.
 *
 * @param s - The live state.
 * @returns The sources there are.
 */
export function liveSources(s: Pick<LiveState, "browser" | "computer">): LiveSource[] {
  const out: LiveSource[] = [];
  if (s.browser.pane) out.push("pane");
  if (s.browser.chrome) out.push("chrome");
  if (s.computer.enabled) out.push("computer");
  return out;
}

/**
 * The picture to show: the one the user picked while it still exists, otherwise where the last action happened (a
 * browser action in Chrome when Chrome is driven, else the pane), otherwise the first there is.
 *
 * @param s - The live state.
 * @param picked - The user's tap on a tab, if any.
 * @returns The source, or undefined when there is nothing to show.
 */
export function pickSource(s: Pick<LiveState, "browser" | "computer" | "log">, picked?: LiveSource): LiveSource | undefined {
  const there = liveSources(s);
  if (picked && there.includes(picked)) return picked;
  const last = [...s.log].reverse().find((a) => a.action !== "stop" && a.action !== "pause" && a.action !== "resume");
  const fromLog: LiveSource | undefined = !last ? undefined : last.kind === "computer" ? "computer" : s.browser.chrome && (!s.browser.pane || last.where === s.browser.chrome) ? "chrome" : "pane";
  return fromLog && there.includes(fromLog) ? fromLog : there[0];
}
