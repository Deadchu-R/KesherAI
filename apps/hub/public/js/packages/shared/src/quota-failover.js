/** Which executors may take each kind (anything else in a saved order is dropped). */
export const FAILOVER_TARGETS = {
    code: ["ghostcli", "opencode", "antigravity", "local"],
    research: ["gemini", "ghostcli", "antigravity"],
};
/**
 * The defaults (Roee, 27.11): code GhostCLI → OpenCode Go (its free models first, inside its own runner) → Antigravity
 * (waits for the Run tap) → the local model for small tasks; research Gemini → GhostCLI → Antigravity.
 */
export const FAILOVER_DEFAULTS = { enabled: true, moveManual: true, code: [...FAILOVER_TARGETS.code], research: [...FAILOVER_TARGETS.research] };
/**
 * A fallback order as the user saved it, cleaned: only the kind's executors, each once; the ones left out keep their
 * default place at the end (so a new executor is never lost from an older saved order).
 *
 * @param kind - The task kind.
 * @param saved - What was saved (anything).
 * @returns The order.
 */
export function cleanFailoverOrder(kind, saved) {
    const allowed = FAILOVER_TARGETS[kind];
    const given = Array.isArray(saved) ? saved.filter((x) => allowed.includes(x)) : [];
    return [...new Set([...given, ...allowed])];
}
/** Statuses of a task that has not started (or stopped on its quota) and may move. */
const MOVABLE = new Set(["waiting", "queued", "deferred-quota"]);
/**
 * Why a task may not go to an executor (the safety rules), or undefined when it may.
 *
 * @param t - The task.
 * @param to - The executor.
 * @param room - What the executor can do now.
 * @returns The reason in English, or undefined.
 */
export function failoverBlock(t, to, room) {
    const kind = t.kind ?? "code";
    if (!FAILOVER_TARGETS[kind].includes(to))
        return `${to} does not take ${kind} tasks`;
    if (!room)
        return `${to} is not set up`;
    if (room.extraCost)
        return `${to} would cost extra money`;
    if (t.sensitive && to !== "antigravity")
        return "a security-sensitive task goes only to Antigravity";
    if (room.relay && !t.relayOk)
        return "not safe for a relay";
    if (room.training && !t.trainOk)
        return "not safe for a service that may train";
    if (to === "local" && (t.size !== "S" || t.risk !== "low"))
        return "the local model takes only small low-risk tasks";
    // Big work stays off OpenCode Go (Roee, 21.11: L tasks go to Antigravity, or to GhostCLI when safe).
    if (to === "opencode" && t.size === "L")
        return "L tasks stay off OpenCode Go";
    if (!room.open)
        return `${to} has no quota now`;
    return undefined;
}
/**
 * The order to try for a task: its own preference first (when it is one of the kind's executors), then the settings'
 * order for its kind.
 *
 * @param t - The task.
 * @param s - The settings.
 * @returns The executors, each once.
 */
export function failoverOrder(t, s) {
    const kind = t.kind ?? "code";
    const order = cleanFailoverOrder(kind, s[kind]);
    const own = FAILOVER_TARGETS[kind].includes(t.executor) ? [t.executor] : [];
    return [...new Set([...own, ...order])];
}
/**
 * Decides whether a waiting task moves because its executor has no quota now, and where.
 *
 * @param t - The task.
 * @param rooms - Each executor's room now (the task's own executor included, even when it is not a target).
 * @param s - The settings.
 * @returns `stay` (with why), `move` to an executor, or `ask` (a hand-picked task while "move my tasks too" is off).
 */
export function pickFailover(t, rooms, s) {
    if (!s.enabled)
        return { action: "stay", why: "the failover is off" };
    // No bounce: a task that runs (or waits for a step's answer) stays where it is.
    if (!MOVABLE.has(t.status))
        return { action: "stay", why: "it is not waiting" };
    // Claude's Opus agent has no quota here: it is never moved.
    if (t.runBy === "opus")
        return { action: "stay", why: "Claude's own agent" };
    const here = rooms[t.runBy];
    if (!here || here.open)
        return { action: "stay", why: "its executor has quota" };
    const back = here.until;
    for (const to of failoverOrder(t, s)) {
        if (to === t.runBy || to === t.movedFrom?.from || t.movedFrom?.via?.includes(to))
            continue;
        if (failoverBlock(t, to, rooms[to]))
            continue;
        const handPicked = t.executor !== "auto";
        if (handPicked && !s.moveManual)
            return { action: "ask", to, ...(back ? { back } : {}) };
        return { action: "move", to, ...(back ? { back } : {}) };
    }
    return { action: "stay", why: "no other executor has quota and may take it" };
}
/** Display names of the executors (the task row and the hub use them in "moved from X"). */
export const EXECUTOR_NAMES = {
    antigravity: "Antigravity",
    ghostcli: "GhostCLI",
    opencode: "OpenCode Go",
    gemini: "Gemini",
    local: "Local model",
    claude: "Claude Code",
    opus: "Claude Opus",
};
