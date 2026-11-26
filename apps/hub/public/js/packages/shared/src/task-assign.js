import { SPECIALISTS, SPECIALIST_IDS } from "./engine-specialists.js";
/** Chat agent roles a task can be given to (an outside agent is Antigravity's own entry). */
export const ASSIGN_ROLES = ["lookup", "research", "build"];
/** The list, in the order it is shown. */
export const ASSIGN_CHOICES = [
    { to: "claude", icon: "✷", he: "Claude (סוכן Opus)", en: "Claude (Opus agent)", noteHe: "Claude מריץ אותה בסוכן שלו", noteEn: "Claude runs it with its own agent" },
    { to: "antigravity", icon: "✦", he: "Antigravity", en: "Antigravity", noteHe: "מחכה ללחיצה על הרצה", noteEn: "Waits for your Run" },
    { to: "gemini", icon: "✧", he: "Gemini (חינמי, מחקר)", en: "Gemini (free, research)", noteHe: "רץ לבד, למשימות מחקר בלבד", noteEn: "Runs by itself, research tasks only" },
    { to: "claude-code", icon: "✳", he: "Claude Code במחשב", en: "Claude Code on the PC", noteHe: "המנוי שלך, מחכה ללחיצה על הרצה", noteEn: "Your subscription, waits for your Run" },
    { to: "opencode", icon: "◈", he: "OpenCode Go (תוכנית קבועה)", en: "OpenCode Go (flat plan)", noteHe: "רץ לבד, משימות קוד", noteEn: "Runs by itself, code tasks" },
    { to: "ghostcli", icon: "👻", he: "GhostCLI (ריליי, ניסיון)", en: "GhostCLI (relay, trial)", noteHe: "רק על GhostCLI, בלי מידע רגיש", noteEn: "Only on GhostCLI, no sensitive content" },
    { to: "local", icon: "◆", he: "מודל מקומי (עבודה עצמית)", en: "Local model (self-work)", noteHe: "דרך לוח המשימות", noteEn: "Through the task board" },
    { to: "helper:lookup", icon: "🔎", he: "סוכן חיפוש בצ׳אט", en: "Lookup agent in a chat", noteHe: "צ׳אט קוד חדש", noteEn: "A new code chat" },
    { to: "helper:research", icon: "📚", he: "סוכן מחקר בצ׳אט", en: "Research agent in a chat", noteHe: "צ׳אט קוד חדש", noteEn: "A new code chat" },
    { to: "helper:build", icon: "🛠️", he: "סוכן בנייה בצ׳אט", en: "Build agent in a chat", noteHe: "צ׳אט קוד חדש", noteEn: "A new code chat" },
    // The engine specialists (engine-specialists.ts): a new chat whose lead hands the task to that specialist.
    ...SPECIALIST_IDS.map((id) => {
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
export function parseAssignTo(x) {
    return ASSIGN_CHOICES.find((c) => c.to === x)?.to;
}
/** The task inbox's executor for a target (a chat role has none: it leaves the inbox). */
export function inboxExecutorOf(to) {
    return to === "claude" ? "opus" : to === "claude-code" ? "claude" : to === "ghostcli" ? "opencode" : to === "antigravity" || to === "local" || to === "gemini" || to === "opencode" ? to : undefined;
}
/** A chat role of a target, if it is one: a helper type, or an engine specialist. */
export const roleOf = (to) => (to.startsWith("helper:") ? to.slice(7) : undefined);
/** The model mark of a task given to GhostCLI: it runs only on the relay's models (inbox-runner.ts). */
export const RELAY_PIN = "ghostcli/*";
/** The current executor of an inbox task as a target (to mark it in the list); `model` tells GhostCLI from OpenCode Go. */
export function assignOfExecutor(runBy, model) {
    if (runBy === "opencode" && model === RELAY_PIN)
        return "ghostcli";
    return runBy === "opus" ? "claude" : runBy === "claude" ? "claude-code" : runBy === "antigravity" || runBy === "local" || runBy === "gemini" || runBy === "opencode" ? runBy : undefined;
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
export function helperHandoff(role, title, text) {
    const first = SPECIALIST_IDS.includes(role)
        ? `Hand this task to the ${SPECIALISTS[role].en} engine specialist (delegate with agent "${role}"), then tell me what it made and its checklist.`
        : `Hand this task to one ${role} sub-agent (delegate with kind "${role}"), then tell me what it found or changed.`;
    return [first, "", `Task: ${title}`, "", "```text", text.replace(/```/g, "'''").slice(0, 6000), "```"].join("\n");
}
/**
 * The question to ask before taking over a task, in both languages.
 *
 * @param ask - Why the PC asks.
 * @param to - The new target.
 * @returns The question.
 */
export function assignQuestion(ask, to) {
    const c = ASSIGN_CHOICES.find((x) => x.to === to);
    return ask === "running"
        ? { he: `המשימה רצה עכשיו. לעצור אותה (העבודה עד עכשיו נשמרת) ולתת אותה ל-${c.he}?`, en: `It is running now. Stop it (the work so far is kept) and give it to ${c.en}?` }
        : { he: `המשימה כבר הסתיימה. להריץ אותה שוב עם ${c.he}?`, en: `It has finished. Run it again with ${c.en}?` };
}
