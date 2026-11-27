/**
 * "Running now" half of the Claude agents panel: the lead (Claude) writes `claude/agents.json` on the `claude-status`
 * branch with `tools/hub-report/agents-status.mjs`; the PC reads it from its local clone after the task inbox's fetch.
 * This is the one place that checks that file (it is data from outside: bad JSON, too many entries, unknown states
 * and odd strings are dropped) and decides "maybe stuck". Pure, so it is tested in Node and the phone page shares it.
 * Layout: the design doc's HubAgentsWork board.
 */
/** The branch and path the lead's script writes and the PC reads. */
export const CLAUDE_STATUS_REF = "origin/claude-status";
export const CLAUDE_STATUS_FILE = "claude/agents.json";
/** The most entries the file holds. */
export const CLAUDE_STATUS_MAX = 10;
/** A running agent with no update for this long is "maybe stuck" (ms). */
export const CLAUDE_STUCK_MS = 45 * 60_000;
const STATES = ["running", "done", "failed"];
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const oneLine = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const time = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
/**
 * Checks the file's text. Anything that is not a valid file gives `undefined`; inside a valid file an entry with a bad id,
 * state or start time is dropped, strings are cut to one short line, and entries past {@link CLAUDE_STATUS_MAX} are ignored.
 *
 * @param text - The file's content.
 * @returns The cleaned file, or undefined when it is not usable.
 */
export function parseClaudeStatus(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.agents))
        return undefined;
    const r = raw;
    const agents = [];
    for (const x of r.agents.slice(0, CLAUDE_STATUS_MAX)) {
        if (!x || typeof x !== "object")
            continue;
        const a = x;
        const startedAt = time(a.startedAt);
        if (typeof a.id !== "string" || !ID_RE.test(a.id) || !STATES.includes(a.state) || !startedAt)
            continue;
        const updatedAt = time(a.updatedAt);
        const note = oneLine(a.lastNote, 200);
        agents.push({ id: a.id, title: oneLine(a.title, 120) || a.id, model: oneLine(a.model, 40), startedAt, state: a.state, ...(updatedAt ? { updatedAt } : {}), ...(note ? { lastNote: note } : {}) });
    }
    return { updatedAt: time(r.updatedAt) ?? 0, agents };
}
/**
 * Is a running agent "maybe stuck": running, and nothing heard from it for {@link CLAUDE_STUCK_MS}.
 *
 * @param a - The entry.
 * @param now - The time now (ms; tests pass a fake clock).
 */
export function isMaybeStuck(a, now) {
    return a.state === "running" && now - (a.updatedAt ?? a.startedAt) > CLAUDE_STUCK_MS;
}
/**
 * The entries to show as "Running now": the running ones, longest-running first.
 *
 * @param file - From {@link parseClaudeStatus}.
 */
export function runningAgents(file) {
    return (file?.agents ?? []).filter((a) => a.state === "running").sort((a, b) => a.startedAt - b.startedAt);
}
/** Whole minutes since `since` (never negative). */
export function minutesSince(since, now) {
    return Math.max(0, Math.floor((now - since) / 60_000));
}
