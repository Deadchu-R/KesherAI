/**
 * Claude Code as a task-inbox executor (docs/WORK_LIST.md "Claude as a KesherAI executor"; docs/RESEARCH_LOG.md
 * 2026-11-24): the user's own `claude` CLI on the PC, signed in with their own Claude subscription (never an API key),
 * run headless in a worktree. These are the settings, the state the pages show, and the quota rule both sides share.
 *
 * @packageDocumentation
 */
/** The defaults (Roee, 2026-11-24). */
export const CLAUDE_DEFAULTS = { enabled: true, askRun: true, dailyCap: 5, fiveHourMax: 80, weekMax: 85, model: "" };
/**
 * Whether the quota holds back a new Claude Code task: a window at or above its threshold that has not reset yet. A
 * missing window is unknown and holds nothing back (a usage-limit message from the CLI still stops the run).
 *
 * @param q - The last reading (undefined: unknown).
 * @param s - The thresholds.
 * @param now - The clock (ms).
 * @returns The window that blocks, its percent and its reset, or undefined.
 */
export function claudeQuotaBlock(q, s, now) {
    if (!q)
        return undefined;
    const over = (w, max) => !!w && w.resetsAt > now && w.usedPercentage >= max;
    // The weekly window first: it lasts longer, so its reset is the real "until".
    if (over(q.sevenDay, s.weekMax))
        return { window: "seven_day", used: q.sevenDay.usedPercentage, until: q.sevenDay.resetsAt };
    if (over(q.fiveHour, s.fiveHourMax))
        return { window: "five_hour", used: q.fiveHour.usedPercentage, until: q.fiveHour.resetsAt };
    return undefined;
}
/**
 * A window's percent for a card: rounded, or undefined when unknown or already reset.
 *
 * @param w - The window.
 * @param now - The clock (ms).
 */
export function claudeWindowPercent(w, now) {
    return w && w.resetsAt > now ? Math.round(w.usedPercentage) : undefined;
}
