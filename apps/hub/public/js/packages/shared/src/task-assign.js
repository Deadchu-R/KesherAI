/** Chat agent roles a task can be given to (an outside agent is Antigravity's own entry). */
export const ASSIGN_ROLES = ["lookup", "research", "build"];
/** The list, in the order it is shown. */
export const ASSIGN_CHOICES = [
    { to: "claude", icon: "✷", he: "Claude (סוכן Opus)", en: "Claude (Opus agent)", noteHe: "Claude מריץ אותה בסוכן שלו", noteEn: "Claude runs it with its own agent" },
    { to: "antigravity", icon: "✦", he: "Antigravity", en: "Antigravity", noteHe: "מחכה ללחיצה על הרצה", noteEn: "Waits for your Run" },
    { to: "local", icon: "◆", he: "מודל מקומי (עבודה עצמית)", en: "Local model (self-work)", noteHe: "דרך לוח המשימות", noteEn: "Through the task board" },
    { to: "helper:lookup", icon: "🔎", he: "סוכן חיפוש בצ׳אט", en: "Lookup agent in a chat", noteHe: "צ׳אט קוד חדש", noteEn: "A new code chat" },
    { to: "helper:research", icon: "📚", he: "סוכן מחקר בצ׳אט", en: "Research agent in a chat", noteHe: "צ׳אט קוד חדש", noteEn: "A new code chat" },
    { to: "helper:build", icon: "🛠️", he: "סוכן בנייה בצ׳אט", en: "Build agent in a chat", noteHe: "צ׳אט קוד חדש", noteEn: "A new code chat" },
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
    return to === "claude" ? "opus" : to === "antigravity" || to === "local" ? to : undefined;
}
/** A chat role of a target, if it is one. */
export const roleOf = (to) => (to.startsWith("helper:") ? to.slice(7) : undefined);
/** The current executor of an inbox task as a target (to mark it in the list). */
export function assignOfExecutor(runBy) {
    return runBy === "opus" ? "claude" : runBy === "antigravity" || runBy === "local" ? runBy : undefined;
}
/**
 * The first message of the chat a task is handed to (a chat role): the lead hands the whole task to one sub-agent of
 * that role and reports back. The task's text is data, quoted.
 *
 * @param role - The role.
 * @param title - The task's title.
 * @param text - What to do.
 * @returns The message.
 */
export function helperHandoff(role, title, text) {
    return [`Hand this task to one ${role} sub-agent (delegate with kind "${role}"), then tell me what it found or changed.`, "", `Task: ${title}`, "", "```text", text.replace(/```/g, "'''").slice(0, 6000), "```"].join("\n");
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
