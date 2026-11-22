/**
 * Pure helpers for the fold of a turn's steps ("▸ What the model did · 12 steps · 1:42") and for the screenshots
 * between them: the header text, the clock, and where a step's action (click, typing, scroll) is drawn on a
 * screenshot. No React and no i18n imports, so they run in `node:test`; callers pass `he` (true for Hebrew).
 */

/** "1:42", "0:07", "1:02:03". */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** What the fold's header needs. */
export interface FoldInfo {
  /** How many steps (calls) the turn has. */
  steps: number;
  /** Milliseconds from the first call to the last result (or now, while it runs); undefined when unknown. */
  ms?: number | undefined;
  /** True while the turn still works. */
  running: boolean;
  /** The step in progress, as a short sentence ("click 'Save'"), while running. */
  current?: string | undefined;
}

/**
 * The header line of a turn's fold: "What the model did · 12 steps · 1:42", or while it works
 * "Working… step 5: click 'Save'".
 *
 * @param f - The steps' count, time and current step.
 * @param he - True for Hebrew.
 */
export function foldHeader(f: FoldInfo, he: boolean): string {
  if (f.running) {
    const head = he ? `עובד… צעד ${f.steps}` : `Working… step ${f.steps}`;
    return f.current ? `${head}: ${f.current}` : head;
  }
  const n = he ? (f.steps === 1 ? "צעד אחד" : `${f.steps} צעדים`) : `${f.steps} ${f.steps === 1 ? "step" : "steps"}`;
  return [he ? "מה המודל עשה" : "What the model did", n, ...(f.ms !== undefined ? [formatClock(f.ms)] : [])].join(" · ");
}

/** The time a run of steps took: from the first call to the last result, or to `now` while one has no result. */
export function turnDuration(steps: Array<{ call: { at?: string }; result?: { at?: string } | undefined }>, now: number): number | undefined {
  const first = steps[0]?.call.at ? Date.parse(steps[0].call.at) : NaN;
  if (!Number.isFinite(first)) return undefined;
  const open = steps.some((s) => !s.result);
  const ends = steps.map((s) => (s.result?.at ? Date.parse(s.result.at) : NaN)).filter(Number.isFinite);
  const end = open ? now : ends.length ? Math.max(...ends) : NaN;
  return Number.isFinite(end) ? Math.max(0, end - first) : undefined;
}

/** What a step did on the screen: a click, typing or a scroll, in the screenshot's pixels. */
export interface StepAction {
  kind: "click" | "type" | "scroll";
  x?: number;
  y?: number;
  /** The typed text (cut). */
  text?: string;
  /** Scroll direction. */
  dir?: "up" | "down" | "left" | "right";
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * The action a computer or browser call did, to draw on the screenshot it acted on.
 *
 * @param name - The tool's name.
 * @param input - The call's arguments.
 * @returns The action, or undefined for a call that does nothing visible (a screenshot, a read).
 */
export function stepAction(name: string, input: Record<string, unknown>): StepAction | undefined {
  const x = num(input.x);
  const y = num(input.y);
  const at = { ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) };
  if (/^(computer_(click|double_click|right_click|move)|browser_click_at)$/.test(name) && x !== undefined && y !== undefined) return { kind: "click", ...at };
  if (/^(computer_type|browser_type)$/.test(name) && typeof input.text === "string") return { kind: "type", ...at, text: input.text.length > 40 ? `${input.text.slice(0, 39)}…` : input.text };
  if (/^(computer_scroll|browser_scroll)$/.test(name)) {
    const amount = num(input.amount);
    const dir = typeof input.direction === "string" && /^(up|down|left|right)$/.test(input.direction) ? (input.direction as StepAction["dir"]) : amount !== undefined ? (amount < 0 ? "up" : "down") : "down";
    return { kind: "scroll", ...at, dir };
  }
  return undefined;
}

/** A picture's size. */
export interface Frame { w: number; h: number }

/**
 * The size of the screen a computer screenshot step described ("Screenshot 1280×720. In front: …").
 *
 * @param output - The screenshot tool's text.
 */
export function shotFrame(output: string): Frame | undefined {
  const m = /Screenshot (\d{2,5})\s*[×x]\s*(\d{2,5})/.exec(output);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : undefined;
}

/**
 * Where a point of the screenshot's own pixels lies on the shown picture, as percents of its width and height (so
 * it holds at any display size: the 240 px thumbnail and the big lightbox use the same numbers). Points outside
 * the picture are held at its edge.
 *
 * @param p - The point, in `from` pixels.
 * @param from - The pixel size the point is in (what the model saw).
 */
export function overlayPercent(p: { x: number; y: number }, from: Frame): { left: number; top: number } {
  const c = (v: number) => Math.min(100, Math.max(0, v));
  return { left: c((p.x / from.w) * 100), top: c((p.y / from.h) * 100) };
}

/** A step of a group, as far as the screenshot pairing reads it. */
interface PairStep { call: { callId: string; name: string; input: Record<string, unknown> }; result?: { output: string; assetIds?: string[] | undefined } | undefined }

/** The screenshot an action step acted on, and what size its pixels were. */
export interface ActedOn { assetId: string; frame?: Frame; action: StepAction }

/**
 * For each step with an on-screen action, the latest earlier screenshot of the same turn (what the model looked at
 * when it chose the point).
 *
 * @param steps - The turn's steps, in order.
 * @returns Per call id.
 */
export function actedOnShots(steps: PairStep[]): Map<string, ActedOn> {
  const out = new Map<string, ActedOn>();
  let last: { assetId: string; frame?: Frame } | undefined;
  for (const s of steps) {
    const action = stepAction(s.call.name, s.call.input ?? {});
    if (action && last) out.set(s.call.callId, { ...last, action });
    const id = s.result?.assetIds?.[0];
    if (id && /^(computer_|browser_)|screenshot/.test(s.call.name) && !action) {
      const frame = shotFrame(s.result?.output ?? "");
      last = { assetId: id, ...(frame ? { frame } : {}) };
    }
  }
  return out;
}
