/**
 * Agent names and notes (docs/RESEARCH_LOG.md, "Agent names and notes", 2026-11-20): the owner's own name and note for
 * an agent run, and the run's automatic "doing now" line. Plain data, no browser or Node API, so the PC, the app and
 * the hub page share it.
 *
 * - The name replaces the run's title wherever it is shown; the title stays as a subtitle.
 * - The note is the owner's own text about the run. It is never given to the agent's model.
 * - "Doing now" is worked out from the run's state and its latest tool, so it needs no input and is never the note.
 */
/** How long a name and a note may be. */
export const AGENT_LABEL_LIMITS = { nameChars: 80, noteChars: 500 };
/** Control characters (a note keeps its line breaks and tabs). */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‎‏‪-‮⁦-⁩]/g;
/**
 * A clean label from untrusted input: text only, control and direction-override characters removed, trimmed and
 * cut to {@link AGENT_LABEL_LIMITS}; the name is one line. An empty field is left out (that clears it).
 *
 * @param x - Untrusted input (`{ name?, note? }`).
 * @param at - When it was set (ms), kept as `at` when given.
 * @returns The label (possibly with neither field).
 */
export function cleanAgentLabel(x, at) {
    const o = x && typeof x === "object" ? x : {};
    const text = (v) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(CONTROL, "") : "");
    const name = text(o.name).replace(/\s+/g, " ").trim().slice(0, AGENT_LABEL_LIMITS.nameChars).trim();
    const note = text(o.note)
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, AGENT_LABEL_LIMITS.noteChars)
        .trim();
    return { ...(name ? { name } : {}), ...(note ? { note } : {}), ...(typeof at === "number" && Number.isFinite(at) && at > 0 ? { at: Math.floor(at) } : {}) };
}
/** Whether two labels show the same name and note. */
export const sameLabel = (a, b) => (a?.name ?? "") === (b?.name ?? "") && (a?.note ?? "") === (b?.note ?? "");
/** The common tools in words: [Hebrew, English]. The Antigravity inbox reports verbs (`edit`, `run`). */
const TOOL_WORDS = {
    read_file: ["קורא", "Reading"],
    read: ["קורא", "Reading"],
    view_image: ["מסתכל על תמונה", "Looking at an image"],
    edit_file: ["עורך", "Editing"],
    edit: ["עורך", "Editing"],
    write_file: ["כותב", "Writing"],
    write: ["כותב", "Writing"],
    create: ["יוצר", "Creating"],
    delete_file: ["מוחק", "Deleting"],
    delete: ["מוחק", "Deleting"],
    list_files: ["עובר על התיקייה", "Looking through the folder"],
    list: ["עובר על התיקייה", "Looking through the folder"],
    search: ["מחפש בקוד", "Searching the code"],
    grep: ["מחפש בקוד", "Searching the code"],
    run_command: ["מריץ פקודה", "Running a command"],
    run: ["מריץ פקודה", "Running a command"],
    run_tests: ["מריץ בדיקות", "Running tests"],
    web_search: ["מחפש ברשת", "Searching the web"],
    web_fetch: ["קורא דף ברשת", "Reading a web page"],
    fetch: ["קורא דף ברשת", "Reading a web page"],
    delegate: ["מעביר משימה לסוכן משנה", "Handing work to a sub-agent"],
    quota: ["מחכה למכסה", "Waiting for quota"],
};
/** Tools whose target is a file path (shown after the verb). */
const FILE_TOOLS = new Set(["read_file", "read", "edit_file", "edit", "write_file", "write", "create", "delete_file", "delete", "list_files", "list"]);
/**
 * The run's automatic "doing now" line, short, from its state and latest tool: "Editing src/app.ts", "Running tests",
 * "Waiting in the queue". Ended runs have none (their result line is shown instead).
 *
 * @param d - The state, the latest tool and its target.
 * @returns The line in both languages, or undefined.
 */
export function agentDoing(d) {
    switch (d.state) {
        case "queued":
            return { he: "ממתין בתור", en: "Waiting in the queue" };
        case "waiting":
        case "asking":
            return { he: "מחכה לך", en: "Waiting for you" };
        case "running":
            break;
        default:
            return undefined;
    }
    const tool = (d.tool ?? "").trim().toLowerCase();
    if (!tool || tool === "step")
        return { he: "חושב…", en: "Thinking…" };
    const words = TOOL_WORDS[tool];
    const target = d.target && FILE_TOOLS.has(tool) ? ` ${shortPath(d.target)}` : "";
    if (words)
        return { he: `${words[0]}${target}`, en: `${words[1]}${target}` };
    const name = tool.replace(/[^\w.-]/g, "").slice(0, 40);
    return { he: `משתמש בכלי ${name}`, en: `Using ${name}` };
}
/** A path's last two parts (`…/ui/App.tsx`), so the line stays short. */
function shortPath(p) {
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    const tail = parts.slice(-2).join("/").slice(-60);
    return parts.length > 2 ? `…/${tail}` : tail;
}
/**
 * A helper run's step text (`tool: argument`) split into the tool and a target that is safe to show (file tools
 * only: their path).
 *
 * @param step - The step text, as helper-runs.ts writes it.
 * @returns The tool and maybe the target.
 */
export function stepTool(step) {
    if (!step)
        return {};
    const i = step.indexOf(":");
    const tool = (i > 0 ? step.slice(0, i) : step).trim();
    if (!/^[\w.-]{1,60}$/.test(tool))
        return {};
    const arg = i > 0 ? step.slice(i + 1).trim().split("\n")[0].slice(0, 200) : "";
    return { tool, ...(arg && FILE_TOOLS.has(tool) ? { target: arg } : {}) };
}
