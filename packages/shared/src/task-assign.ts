/**
 * "Who does it" (Roee, 2026-11-20 21:47): the list a task can be given to, from the PC app, the phone and the hub
 * page. A task of the task inbox goes back in the queue for the new executor; a work-list item becomes a new inbox
 * task for it; a chat agent role gets the task in a new code chat, whose lead hands it to a sub-agent of that role.
 * The PC is the source of truth: the hub page sends a sealed `assign` command and shows the PC's answer.
 *
 * A running or finished task is never taken over silently: the PC answers `ask` with a question, and the user's yes
 * sends the same command again with `confirm`.
 */
import type { HelperKind } from "./agent.js";
import { SPECIALISTS, SPECIALIST_IDS, type SpecialistId } from "./engine-specialists.js";

/** Chat agent roles a task can be given to (an outside agent is Antigravity's own entry). */
export const ASSIGN_ROLES = ["lookup", "research", "build"] as const satisfies readonly HelperKind[];
/** One of {@link ASSIGN_ROLES}. */
export type AssignRole = (typeof ASSIGN_ROLES)[number];

/** Who a task goes to. */
export type AssignTo = "claude" | "antigravity" | "local" | `helper:${AssignRole}` | `helper:${SpecialistId}`;

/** One entry of the list. */
export interface AssignChoice {
  to: AssignTo;
  icon: string;
  he: string;
  en: string;
  /** What happens, in a few words. */
  noteHe: string;
  noteEn: string;
}

/** The list, in the order it is shown. */
export const ASSIGN_CHOICES: readonly AssignChoice[] = [
  { to: "claude", icon: "✷", he: "Claude (סוכן Opus)", en: "Claude (Opus agent)", noteHe: "Claude מריץ אותה בסוכן שלו", noteEn: "Claude runs it with its own agent" },
  { to: "antigravity", icon: "✦", he: "Antigravity", en: "Antigravity", noteHe: "מחכה ללחיצה על הרצה", noteEn: "Waits for your Run" },
  { to: "local", icon: "◆", he: "מודל מקומי (עבודה עצמית)", en: "Local model (self-work)", noteHe: "דרך לוח המשימות", noteEn: "Through the task board" },
  { to: "helper:lookup", icon: "🔎", he: "סוכן חיפוש בצ׳אט", en: "Lookup agent in a chat", noteHe: "צ׳אט קוד חדש", noteEn: "A new code chat" },
  { to: "helper:research", icon: "📚", he: "סוכן מחקר בצ׳אט", en: "Research agent in a chat", noteHe: "צ׳אט קוד חדש", noteEn: "A new code chat" },
  { to: "helper:build", icon: "🛠️", he: "סוכן בנייה בצ׳אט", en: "Build agent in a chat", noteHe: "צ׳אט קוד חדש", noteEn: "A new code chat" },
  // The engine specialists (engine-specialists.ts): a new chat whose lead hands the task to that specialist.
  ...SPECIALIST_IDS.map((id): AssignChoice => {
    const s = SPECIALISTS[id];
    return { to: `helper:${id}`, icon: s.icon, he: `סוכן ${s.he} למנוע`, en: `${s.en} agent (engine)`, noteHe: s.noteHe, noteEn: s.noteEn };
  }),
];

/**
 * A target from untrusted input.
 *
 * @param x - Untrusted input.
 * @returns The target, or undefined.
 */
export function parseAssignTo(x: unknown): AssignTo | undefined {
  return ASSIGN_CHOICES.find((c) => c.to === x)?.to;
}

/** The task inbox's executor for a target (a chat role has none: it leaves the inbox). */
export function inboxExecutorOf(to: AssignTo): "opus" | "antigravity" | "local" | undefined {
  return to === "claude" ? "opus" : to === "antigravity" || to === "local" ? to : undefined;
}

/** A chat role of a target, if it is one: a helper type, or an engine specialist. */
export const roleOf = (to: AssignTo): AssignRole | SpecialistId | undefined => (to.startsWith("helper:") ? (to.slice(7) as AssignRole | SpecialistId) : undefined);

/** The current executor of an inbox task as a target (to mark it in the list). */
export function assignOfExecutor(runBy: string | undefined): AssignTo | undefined {
  return runBy === "opus" ? "claude" : runBy === "antigravity" || runBy === "local" ? runBy : undefined;
}

/**
 * The first message of the chat a task is handed to (a chat role): the lead hands the whole task to one sub-agent of
 * that role and reports back. The task's text is data, quoted.
 *
 * @param role - The role (a helper type, or an engine specialist).
 * @param title - The task's title.
 * @param text - What to do.
 * @returns The message.
 */
export function helperHandoff(role: AssignRole | SpecialistId, title: string, text: string): string {
  const first = (SPECIALIST_IDS as readonly string[]).includes(role)
    ? `Hand this task to the ${SPECIALISTS[role as SpecialistId].en} engine specialist (delegate with agent "${role}"), then tell me what it made and its checklist.`
    : `Hand this task to one ${role} sub-agent (delegate with kind "${role}"), then tell me what it found or changed.`;
  return [first, "", `Task: ${title}`, "", "```text", text.replace(/```/g, "'''").slice(0, 6000), "```"].join("\n");
}

/** The PC's answer to an assignment. `ask`: it needs the user's yes first (the task runs now, or has finished). */
export interface AssignResult {
  ok: boolean;
  text: string;
  ask?: "running" | "finished";
}

/**
 * The question to ask before taking over a task, in both languages.
 *
 * @param ask - Why the PC asks.
 * @param to - The new target.
 * @returns The question.
 */
export function assignQuestion(ask: "running" | "finished", to: AssignTo): { he: string; en: string } {
  const c = ASSIGN_CHOICES.find((x) => x.to === to)!;
  return ask === "running"
    ? { he: `המשימה רצה עכשיו. לעצור אותה (העבודה עד עכשיו נשמרת) ולתת אותה ל-${c.he}?`, en: `It is running now. Stop it (the work so far is kept) and give it to ${c.en}?` }
    : { he: `המשימה כבר הסתיימה. להריץ אותה שוב עם ${c.he}?`, en: `It has finished. Run it again with ${c.en}?` };
}
