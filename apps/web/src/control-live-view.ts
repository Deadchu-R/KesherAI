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
  /** The computer task, running or ended in the last 10 minutes (routes/control-tasks.ts); null when none. */
  task?: ControlTaskView | null;
}

/** A computer task as the server gives it (packages/core/src/control-task.ts). */
export interface ControlTaskView {
  id: string;
  goal: string;
  apps: string[];
  planner?: "gemini" | "local";
  status: "running" | "done" | "failed" | "needs-you" | "stopped";
  step: number;
  maxSteps: number;
  steps: Array<{ n: number; action: string; note: string; ok: boolean; shotThumb?: string }>;
  summary: string;
  lastShot?: string;
  question?: string;
  startedAt: number;
  endedAt?: number;
}

/**
 * Reads the apps box of "Give the computer a task": names split by commas, `.exe` dropped, at most 8.
 *
 * @param text - What the user typed, e.g. "EpicGamesLauncher, notepad.exe".
 * @returns Process names.
 */
export function parseApps(text: string): string[] {
  return [...new Set(text.split(/[,;\n،]+/).map((a) => a.trim().replace(/\.exe$/i, "")).filter((a) => /^[A-Za-z0-9 ._-]{1,60}$/.test(a)))].slice(0, 8);
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

/** The server's step verbs (control-task.ts `describe`) in Hebrew. */
const STEP_HE: Array<[RegExp, string]> = [
  [/^press /, "לחיצה על "], [/^invoke /, "לחיצה על "], [/^toggle /, "החלפת מצב: "], [/^select /, "בחירה: "], [/^expand /, "פתיחה: "], [/^collapse /, "סגירה: "], [/^focus /, "מיקוד: "],
  [/^write (\d+) characters into /, "כתיבת $1 תווים בשדה "], [/^type (\d+) characters$/, "הקלדת $1 תווים"], [/^keys /, "מקשים: "], [/^click at /, "לחיצה בנקודה "],
  [/^scroll /, "גלילה "], [/^open /, "פתיחת "], [/^wait (\d+) s$/, "המתנה $1 שניות"], [/^look$/, "מבט במסך"], [/^done$/, "הושלם"], [/^fail$/, "לא הצליח"], [/^asked you$/, "שאל אותך"],
];

/**
 * A computer task's step in Hebrew: its verb translated; the app's own names (a button's label) stay as they are.
 *
 * @param action - The step as the server wrote it, e.g. `press Button "Library"`.
 */
export function stepWordHe(action: string): string {
  const hit = STEP_HE.find(([re]) => re.test(action));
  return hit ? action.replace(hit[0], hit[1]) : action;
}
