/**
 * A step estimate for a task-inbox task ("~N steps"), made when the task is queued from the task itself: no model
 * call, one small formula. It is a guide for the progress line ("step 4 of ~11"), not a promise: the real count is
 * whatever the agent does, and the line keeps counting past the estimate.
 */
/** The free-Gemini route plans at most this many parts (the same limit as the research runner). */
export const GEMINI_MAX_PARTS = 3;
/** A big research task (Antigravity, Claude) is counted up to this many parts. */
export const BIG_MAX_PARTS = 8;
/** An estimate is never below this nor above {@link MAX_STEPS}. */
export const MIN_STEPS = 3;
export const MAX_STEPS = 60;
/**
 * The parts of a research task: the list items of its acceptance text (`- x`, `* x`, `1. x`), at least one.
 *
 * @param acceptance - The task's acceptance text.
 * @returns How many parts.
 */
export function researchParts(acceptance) {
    const items = (acceptance ?? "").split("\n").filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l)).length;
    return Math.max(1, items);
}
/**
 * Estimates how many agent steps a task takes.
 *
 * - Research: parts x (search + read) + 1 to write the report. The free-Gemini route plans at most
 *   {@link GEMINI_MAX_PARTS} parts; a big research task counts up to {@link BIG_MAX_PARTS}.
 * - Code (Antigravity, the local model, Claude): 3 (look around, plan, wrap up) + about one step per file the task may
 *   touch (at most 15) + one per 400 characters of goal + 2 when there is a check to run and fix.
 *
 * @param t - The task's own fields.
 * @returns A whole number between {@link MIN_STEPS} and {@link MAX_STEPS}.
 */
export function estimateTaskSteps(t) {
    let n;
    if (t.kind === "research") {
        const parts = Math.min(researchParts(t.acceptance), t.runBy === "gemini" ? GEMINI_MAX_PARTS : BIG_MAX_PARTS);
        n = parts * 2 + 1;
    }
    else {
        n = 3 + Math.min(Math.max(t.maxFiles, 1), 15) + Math.ceil(t.goal.length / 400) + (t.check.trim() ? 2 : 0);
    }
    return Math.min(MAX_STEPS, Math.max(MIN_STEPS, Math.round(n)));
}
const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename", "target_file", "dir", "directory", "cwd"];
const QUERY_KEYS = ["pattern", "query", "regex", "search", "glob", "q"];
const CMD_KEYS = ["command", "cmd", "script"];
const URL_KEYS = ["url", "href"];
/** The user folder (Windows, macOS, Linux) as `~`, and a long path cut to its last parts. */
function tidy(s, max = 70) {
    let t = s.replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, "~").replace(/\/(?:home|Users)\/[^/\s"']+/g, "~").replace(/\s+/g, " ").trim();
    // A path inside a run's worktree: from the repo's own folders on.
    t = t.replace(/^.*?[\\/](?=(?:apps|packages|plugins|docs|tools|scripts|src)[\\/])/, "");
    return t.length > max ? `…${t.slice(t.length - max + 1)}` : t;
}
/** The first string under one of the keys. */
function pick(args, keys) {
    for (const k of keys) {
        const v = args[k];
        if (typeof v === "string" && v.trim())
            return v;
        if (Array.isArray(v) && typeof v[0] === "string")
            return v.join(" ");
    }
    return undefined;
}
/**
 * Keeps a step as a {@link StepNote}.
 *
 * @param tool - The tool's name.
 * @param args - Its arguments (an object or a string).
 * @param at - When (ms).
 * @param error - It failed.
 * @returns The note.
 */
export function stepNote(tool, args, at, error = false) {
    let target;
    if (typeof args === "string")
        target = args;
    else if (args && typeof args === "object") {
        const a = args;
        target = pick(a, CMD_KEYS) ?? pick(a, PATH_KEYS) ?? pick(a, QUERY_KEYS) ?? pick(a, URL_KEYS);
    }
    return { tool, ...(target ? { target: tidy(target) } : {}), at, ...(error ? { error: true } : {}) };
}
/**
 * A step in plain words.
 *
 * @param s - The step.
 * @param he - Hebrew (else English).
 * @returns One line.
 */
export function describeStep(s, he) {
    const tool = s.tool.toLowerCase();
    const t = s.target ? ` ${s.target}` : "";
    const say = (h, e) => (he ? h : e) + t;
    let line;
    if (/^(bash|shell|run|exec|terminal|powershell|command|run_command|cmd)/.test(tool) || /(_command|_shell)$/.test(tool)) {
        const c = (s.target ?? "").toLowerCase();
        if (/\b(test|vitest|jest|tsx --test|pytest)\b/.test(c))
            line = he ? "מריץ בדיקות" : "Running the tests";
        else if (/\b(tsc|build|lint|eslint|typecheck)\b/.test(c))
            line = he ? "בודק שהקוד נבנה ותקין" : "Checking the code builds";
        else if (/^git\b/.test(c))
            line = say("git:", "git:");
        else
            line = say("מריץ פקודה:", "Running:");
    }
    else if (/(read|view|cat|open|get_file|show)/.test(tool))
        line = say("קורא", "Reading");
    else if (/(edit|patch|replace|apply|update|str_replace|multi_edit)/.test(tool))
        line = say("עורך", "Editing");
    else if (/(write|create|new_file|save)/.test(tool))
        line = say("כותב", "Writing");
    else if (/(grep|search|find|glob|rg|ripgrep|codebase)/.test(tool))
        line = say("מחפש", "Searching for");
    else if (/(^ls$|list|dir|tree)/.test(tool))
        line = say("מסתכל בתיקייה", "Looking in");
    else if (/(fetch|web|http|browse|url)/.test(tool))
        line = say("קורא דף", "Reading the page");
    else if (/(todo|plan|think|task)/.test(tool))
        line = he ? "מתכנן את הצעדים" : "Planning the steps";
    else if (/(delete|remove|rm)/.test(tool))
        line = say("מוחק", "Deleting");
    else
        line = he ? `משתמש בכלי ${s.tool}${t}` : `Using ${s.tool}${t}`;
    return s.error ? `${line} ${he ? "(נכשל)" : "(failed)"}` : line;
}
