/**
 * Computer tasks (control-task.ts): the pure rules, kept apart so they are tested without a computer.
 *
 * A computer task is one high-level goal ("install Unreal 5.5 from the Epic launcher") that KesherAI carries out on
 * this computer by itself, step by step, instead of a cloud model driving the screen screenshot by screenshot. This
 * file decides:
 * - whether a goal is refused outright (passwords, purchases, permanent deletes) and whether it allows installs;
 * - whether one planned step is refused or must be asked (secrets, purchases, installs the goal did not ask for);
 * - how the planner's JSON answer is read;
 * - whether the screen changed (a cheap diff of a tiny grey frame), so a picture is sent only when it is new;
 * - what to look with (the UI Automation tree, a picture, or nothing new) and which model plans.
 */
import type { Rgba } from "./gif.js";
import { shrinkRgba } from "./shot-store.js";

/** Where a task is. `needs-you` waits for the user's answer (POST …/answer). */
export type ControlTaskStatus = "running" | "done" | "failed" | "needs-you" | "stopped";

/** Which model plans: `auto` = the free Gemini key, then a local vision model; never a paid model. */
export type ControlModel = "auto" | "gemini" | "local";

/** A task as asked for (POST /api/control/tasks). */
export interface ControlTaskRequest {
  goal: string;
  /** Apps (process names) the task may act in without asking; others are asked once. */
  apps: string[];
  maxSteps: number;
  maxMinutes: number;
  model: ControlModel;
}

/** The limits of a request. */
export const TASK_LIMITS = { goalChars: 2000, apps: 8, maxSteps: 120, maxMinutes: 120, defaultSteps: 40, defaultMinutes: 15 } as const;

/**
 * Reads and checks a request body.
 *
 * @param body - The JSON body.
 * @returns The request, or the reason it is refused (for a 400).
 */
export function parseTaskRequest(body: unknown): ControlTaskRequest | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const goal = typeof b.goal === "string" ? b.goal.trim() : "";
  if (!goal) return { error: "Send { goal }: what to do on the computer, in one sentence." };
  if (goal.length > TASK_LIMITS.goalChars) return { error: `The goal is longer than ${TASK_LIMITS.goalChars} characters.` };
  const refused = goalRefusal(goal);
  if (refused) return { error: refused };
  if (b.apps !== undefined && !Array.isArray(b.apps)) return { error: "apps must be a list of app names." };
  const apps = ((b.apps as unknown[] | undefined) ?? []).map((a) => (typeof a === "string" ? a.trim().replace(/\.exe$/i, "") : ""));
  if (apps.some((a) => !/^[A-Za-z0-9 ._-]{1,60}$/.test(a))) return { error: "Each app is a process name: letters, digits, spaces, . _ -." };
  if (apps.length > TASK_LIMITS.apps) return { error: `At most ${TASK_LIMITS.apps} apps.` };
  const int = (v: unknown, def: number, max: number) => (v === undefined ? def : Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max ? (v as number) : NaN);
  const maxSteps = int(b.maxSteps, TASK_LIMITS.defaultSteps, TASK_LIMITS.maxSteps);
  const maxMinutes = int(b.maxMinutes, TASK_LIMITS.defaultMinutes, TASK_LIMITS.maxMinutes);
  if (Number.isNaN(maxSteps)) return { error: `maxSteps is a whole number from 1 to ${TASK_LIMITS.maxSteps}.` };
  if (Number.isNaN(maxMinutes)) return { error: `maxMinutes is a whole number from 1 to ${TASK_LIMITS.maxMinutes}.` };
  const model = b.model === undefined ? "auto" : b.model;
  if (model !== "auto" && model !== "gemini" && model !== "local") return { error: 'model is "auto", "gemini" or "local".' };
  return { goal, apps: [...new Set(apps)], maxSteps, maxMinutes, model };
}

/** Typing a secret, buying, paying or deleting for good: never, whoever asks. */
const GOAL_NEVER: Array<[RegExp, string]> = [
  [/\b(type|enter|fill|paste|put)\b[^.\n]{0,40}\b(password|passcode|pin|2fa|otp|card number|cvv|cvc|iban|api key|secret key|token)\b|(הקלד|הזן|מלא|הדבק)[^.\n]{0,30}(סיסמה|סיסמא|קוד אימות|מספר כרטיס|מפתח api|טוקן)/i, "KesherAI never types passwords, codes, card or bank numbers or keys. Do that part yourself."],
  [/\b(buy|purchase|pay for|checkout|place (an |the )?order|subscribe to|add to cart)\b|(?:^|[\s,.:;"'(])(לקנות|קנה|תקנה|רכוש|לרכוש|לשלם|שלם על|הזמן ושלם|להירשם בתשלום)(?=$|[\s,.!?:;"')])/i, "KesherAI never buys or pays for anything. Do the purchase yourself; it can do the steps after it."],
  [/\b(permanently delete|delete permanently|shift\s*\+\s*delete|empty (the )?recycle bin|wipe|format (the )?(drive|disk))\b|(מחק לצמיתות|מחיקה לצמיתות|רוקן את סל המחזור|לפרמט|פרמוט)/i, "KesherAI never deletes anything for good. Move it to the Recycle Bin yourself."],
];

/**
 * Whether a goal is refused before anything runs.
 *
 * @param goal - The goal.
 * @returns The reason, or undefined when it may run.
 */
export function goalRefusal(goal: string): string | undefined {
  return GOAL_NEVER.find(([re]) => re.test(goal))?.[1];
}

/**
 * Whether the goal itself asks for a download or an install (only then may the task press Install or Download).
 *
 * @param goal - The goal.
 */
export function goalAllowsInstall(goal: string): boolean {
  return /\b(install|download|update|upgrade|set ?up)\b|(התקן|להתקין|תתקין|התקנה|הורד|להוריד|תוריד|הורדה|עדכן|לעדכן|תעדכן)/i.test(goal);
}

/** One step the planner asks for. */
export interface PlanStep {
  do: "invoke" | "set_value" | "type" | "key" | "click" | "scroll" | "open_app" | "look" | "wait" | "done" | "ask" | "fail";
  ref?: string;
  /** For invoke: invoke, toggle, select, expand, collapse or focus. */
  action?: string;
  value?: string;
  text?: string;
  keys?: string;
  x?: number;
  y?: number;
  amount?: number;
  app?: string;
  seconds?: number;
  /** One short line: why (shown in the steps). */
  note?: string;
  summary?: string;
  question?: string;
}

const STEP_KINDS = new Set<PlanStep["do"]>(["invoke", "set_value", "type", "key", "click", "scroll", "open_app", "look", "wait", "done", "ask", "fail"]);

/**
 * Reads the planner's answer: the first JSON object in it (models like to wrap it in ``` fences or add words).
 *
 * @param text - The model's answer.
 * @returns The step, or undefined when there is none or it is malformed.
 */
export function parsePlan(text: string): PlanStep | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  // The first balanced object, strings respected.
  let depth = 0;
  let inStr = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const kind = o.do as PlanStep["do"];
  if (!STEP_KINDS.has(kind)) return undefined;
  const str = (k: string, max = 2000) => (typeof o[k] === "string" ? (o[k] as string).slice(0, max) : undefined);
  const num = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : undefined);
  const step: PlanStep = { do: kind };
  for (const k of ["ref", "action", "keys", "app"] as const) {
    const v = str(k, 80);
    if (v !== undefined) step[k] = v;
  }
  for (const k of ["value", "text"] as const) {
    const v = str(k, 5000);
    if (v !== undefined) step[k] = v;
  }
  for (const k of ["note", "summary", "question"] as const) {
    const v = str(k, 600);
    if (v !== undefined) step[k] = v;
  }
  for (const k of ["x", "y", "amount", "seconds"] as const) {
    const v = num(k);
    if (v !== undefined) step[k] = v;
  }
  const needs: Partial<Record<PlanStep["do"], Array<keyof PlanStep>>> = { invoke: ["ref"], set_value: ["ref", "value"], type: ["text"], key: ["keys"], click: ["x", "y"], scroll: ["x", "y"], open_app: ["app"] };
  return (needs[kind] ?? []).every((k) => step[k] !== undefined) ? step : undefined;
}

/**
 * Whether text looks like a secret: a payment card number (Luhn), an IBAN, or an API key or token.
 *
 * @param text - What would be typed.
 */
export function looksSecret(text: string): boolean {
  const t = text.trim();
  // Card numbers: 13–19 digits, spaces or dashes allowed, passing the Luhn check.
  for (const m of t.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length >= 13 && d.length <= 19 && luhn(d)) return true;
  }
  if (/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/.test(t)) return true; // IBAN
  if (/\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}|\bAIza[0-9A-Za-z_-]{30,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(t)) return true;
  // One long word of mixed letters and digits with no spaces: a key, not words.
  return /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9+/=_-]{32,}$/.test(t);
}

function luhn(d: string): boolean {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

const PURCHASE = /^(buy|buy now|purchase|place order|pay|pay now|checkout|check out|complete purchase|confirm purchase|subscribe|add to cart|get premium|upgrade now|קנה|קנה עכשיו|רכישה|רכוש|לתשלום|שלם|תשלום|הזמן|השלם רכישה|הירשם)(?=$|[\s.…:(!$₪€])/i;
const PRICE = /[$€£₪]\s?\d|\d\s?[$€£₪]|\b(usd|eur|ils)\b/i;
const INSTALL = /^(install|download|get|update|upgrade|התקן|התקנה|הורד|הורדה|קבל|עדכן)(?=$|[\s.…:(])/i;
const DELETE_FOREVER = /(permanently|for good|forever|לצמיתות|empty recycle bin|רוקן את סל המחזור|erase|wipe|format)/i;
const PASSWORDISH = /(password|passcode|pin\b|one-time code|verification code|security code|cvv|cvc|card number|סיסמ|קוד אימות|מספר כרטיס)/i;

/** The element a step acts on, as read from the tree. */
export interface StepTarget {
  type?: string;
  name?: string;
  password?: boolean;
}

/** A verdict on one step: never (told to the planner), or ask the user first. */
export type StepVerdict = { kind: "never"; reason: string } | { kind: "ask"; reason: string } | undefined;

/**
 * KesherAI's own rules for one step of a computer task, on top of computer control's (computer-safety.ts): never
 * type secrets or into password fields, never press Buy or Pay (or anything with a price), never delete for good,
 * press Install or Download only when the goal asks for it.
 *
 * @param s - The step.
 * @param ctx.goal - The task's goal.
 * @param ctx.target - The element the step acts on, when it acts on one.
 * @returns The verdict; undefined when it may run.
 */
export function stepVerdict(s: PlanStep, ctx: { goal: string; target?: StepTarget }): StepVerdict {
  const typed = s.do === "set_value" ? s.value : s.do === "type" ? s.text : undefined;
  const name = (ctx.target?.name ?? "").trim();
  if (typed !== undefined) {
    if (ctx.target?.password || PASSWORDISH.test(name)) return { kind: "never", reason: "That field takes a password or a code: KesherAI never types those. Ask the user (do: ask)." };
    if (looksSecret(typed)) return { kind: "never", reason: "That text looks like a card or bank number or a key: KesherAI never types those." };
  }
  if (s.do === "key" && /\bshift\s*\+\s*(delete|del)\b/i.test(s.keys ?? "")) return { kind: "never", reason: "Shift+Delete deletes for good: never." };
  if (s.do === "invoke" && (s.action ?? "invoke") === "invoke" && name) {
    if (PURCHASE.test(name) || (PRICE.test(name) && /(buy|pay|order|purchase|קנ|שלם|הזמ)/i.test(name))) return { kind: "never", reason: `"${name}" buys or pays: KesherAI never does that. Ask the user (do: ask) or find a free way.` };
    if (DELETE_FOREVER.test(name)) return { kind: "never", reason: `"${name}" deletes for good: never.` };
    if (INSTALL.test(name) && !goalAllowsInstall(ctx.goal)) return { kind: "ask", reason: `"${name}" downloads or installs something, and the task did not ask for that.` };
  }
  return undefined;
}

/** The UI Automation actions that make a control worth acting on by ref. */
const ACTIONABLE = /\[(?:[^\]]*\b)?(invoke|set_value|toggle|select|expand)\b/;

/**
 * How many controls of a computer_tree answer can be acted on by ref (a custom-drawn app shows few or none).
 *
 * @param tree - computer_tree's text.
 */
export function actionableCount(tree: string): number {
  return tree.split("\n").filter((l) => /^\s*u\d+ /.test(l) && ACTIONABLE.test(l) && !/\bdisabled\b/.test(l)).length;
}

/**
 * The element a ref names in a computer_tree answer.
 *
 * @param tree - computer_tree's text.
 * @param ref - A ref like `u12`.
 * @returns Its type, name and whether it is a password field; undefined when the ref is not there.
 */
export function targetOf(tree: string, ref: string): StepTarget | undefined {
  const esc = ref.replace(/[^\w]/g, "");
  const line = tree.split("\n").find((l) => new RegExp(`^\\s*${esc} `).test(l));
  if (!line) return undefined;
  const m = new RegExp(`^\\s*${esc} (\\S+)(?: "([^"]*)")?`).exec(line);
  return { ...(m?.[1] ? { type: m[1] } : {}), ...(m?.[2] ? { name: m[2] } : {}), ...(/\(password field\)/.test(line) ? { password: true } : {}) };
}

/** The tiny grey frame the change detection compares: 32 × 18 cells (or the picture's shape). */
export const FRAME_W = 32;

/**
 * A cheap fingerprint of a screen: shrunk to 32 cells wide, grey.
 *
 * @param img - The screenshot's pixels.
 * @returns One byte per cell.
 */
export function frameSignature(img: Rgba): Uint8Array {
  const s = shrinkRgba(img, FRAME_W);
  const out = new Uint8Array(s.width * s.height);
  for (let i = 0; i < out.length; i++) out[i] = (s.data[i * 4]! * 299 + s.data[i * 4 + 1]! * 587 + s.data[i * 4 + 2]! * 114) / 1000;
  return out;
}

/**
 * Whether the screen changed between two fingerprints: more than 1% of the cells moved by more than 10 grey levels
 * (a blinking caret or a clock does not count; a new dialog or page does).
 *
 * @param a - The earlier fingerprint (undefined: nothing seen yet, so it changed).
 * @param b - The new fingerprint.
 */
export function frameChanged(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return true;
  let moved = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 10) moved++;
  return moved > Math.max(1, a.length * 0.01);
}

/** How a step looks at the screen: the controls' tree (no picture), a new picture, or the tree plus "same as before". */
export type Sense = "tree" | "picture";

/** Enough controls in the tree to work without a picture. */
export const TREE_ENOUGH = 5;

/**
 * What to look with this step, cheapest first: the UI Automation tree when it has enough controls and the planner
 * did not ask to look; otherwise a picture (the caller sends it only when the screen changed).
 *
 * @param s.uia - Whether UI Automation works on this computer.
 * @param s.actionable - Controls in this step's tree that can be acted on.
 * @param s.wantLook - The planner asked for a picture last step.
 */
export function chooseSense(s: { uia: boolean; actionable: number; wantLook: boolean }): Sense {
  return s.uia && !s.wantLook && s.actionable >= TREE_ENOUGH ? "tree" : "picture";
}

/**
 * Which model plans this step. Never a paid model: the free Gemini key first (for `auto` and `gemini`), a local
 * vision model as the fallback (`auto` when Gemini is missing or at its limit) or when asked (`local`).
 *
 * @param model - The task's choice.
 * @param have.gemini - The free Gemini key is set up.
 * @param have.local - A local vision model is installed.
 * @param geminiDown - Gemini answered with a limit or busy error recently.
 * @returns The planner, or undefined when none can plan (the task fails with what to set up).
 */
export function choosePlanner(model: ControlModel, have: { gemini: boolean; local: boolean }, geminiDown = false): "gemini" | "local" | undefined {
  if (model === "local") return have.local ? "local" : undefined;
  if (model === "gemini") return have.gemini ? "gemini" : undefined;
  if (have.gemini && !geminiDown) return "gemini";
  return have.local ? "local" : have.gemini ? "gemini" : undefined;
}

/**
 * Hides personal paths in a log line (main.log must not show the Windows user name).
 *
 * @param text - The line.
 */
export function scrubLog(text: string): string {
  return text
    .replace(/[A-Za-z]:\\Users\\[^\\\s"]+/gi, "<home>")
    .replace(/\/(home|Users)\/[^/\s"]+/g, "<home>")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 400);
}
