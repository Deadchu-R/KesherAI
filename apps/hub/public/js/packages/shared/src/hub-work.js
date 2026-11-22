/**
 * "Who works on what" for the hub page and the phone's Cloud tab (the same page): the pure part. It turns what the PCs
 * report (inbox tasks, board items, live agent runs) into the page's Now strip (one row per worker), the Next list
 * (by priority), the Active / Done / Failed phases and the filters by agent, model and kind. No browser API, so it
 * is tested in Node and compiled into the hub page as is. Layout: the design doc's HubNowNext, HubWorkTabs and
 * HubWorkFilters boards (and their PhoneHub twins).
 */
import { isGoing, shownState } from "./hub-agents.js";
import { boardWho, HUB_WORK_KINDS } from "./hub-protocol.js";
/** The workers the Now strip always lists (a worker that nothing reported on says "free"); Claude only when reported. */
export const WORKERS = ["antigravity", "gemini", "local", "claude"];
/**
 * The page's record of a task-inbox report, so the PC's newest fields replace the old ones (a field a PC stops
 * sending is gone, not kept).
 *
 * @param r - The opened report.
 * @param deviceId - The PC that sent it.
 * @returns What the page keeps in `task.inbox`.
 */
export function inboxMetaOf(r, deviceId) {
    return {
        from: r.from,
        executor: r.executor,
        deviceId,
        ...(r.runId ? { runId: r.runId } : {}),
        at: r.at,
        ...(r.estSteps ? { estSteps: r.estSteps } : {}),
        ...(r.steps ? { steps: r.steps } : {}),
        ...(r.retryAt ? { retryAt: r.retryAt } : {}),
        ...(r.model ? { model: r.model } : {}),
        ...(r.boardId ? { boardId: r.boardId } : {}),
        ...(r.priority !== undefined ? { priority: r.priority } : {}),
        ...(r.queuePos ? { queuePos: r.queuePos } : {}),
        ...(r.kind ? { kind: r.kind } : {}),
        ...(r.startedAt ? { startedAt: r.startedAt } : {}),
        ...(r.endedAt ? { endedAt: r.endedAt } : {}),
        ...(r.cause ? { cause: r.cause } : {}),
    };
}
/** A conversion task: its title or goal asks to convert, port or migrate something (as the task inbox routes them). */
const CONVERSION = /\b(convert|conversion|port|porting|migrate)\b|המר|העבר/i;
/**
 * What a task is, for the kind filter: a research report, a conversion (of a plugin or project to another version or
 * engine) or a code change.
 *
 * @param t - `kind` as the task names it, and the text to look at (title, goal).
 * @returns The kind.
 */
export function workKindOf(t) {
    if (t.kind === "research")
        return "research";
    return CONVERSION.test(`${t.title}\n${t.goal ?? ""}`) ? "conversion" : "code";
}
/**
 * The tab a status belongs to: finished (also partly) is Done; failed, blocked, stopped and expired are Failed;
 * everything else is still Active.
 *
 * @param status - A task's status (a page task's or an agent run's).
 * @param expired - Whether a task sent from this device was never delivered in time.
 * @returns The phase.
 */
export function phaseOf(status, expired = false) {
    if (expired)
        return "failed";
    if (status === "done" || status === "partial")
        return "done";
    if (status === "failed" || status === "blocked" || status === "cancelled")
        return "failed";
    return "active";
}
/** The worker of a page task: the PC's executor for an inbox task, else the executor the owner chose. */
export function workerOf(t) {
    const ex = t.inbox?.executor;
    if (ex)
        return ex;
    if (t.executor === "pc-antigravity")
        return "antigravity";
    if (t.executor === "pc-local")
        return "local";
    return t.route === "claude-cloud" || t.executor === "claude-cloud" ? "claude" : "local";
}
/**
 * A page task as the work views use it.
 *
 * @param t - The task.
 * @param expired - Whether it expired undelivered (`HubDevice.expired`).
 * @param board - The board's items by id, to fill in a priority the report did not carry.
 * @returns The work task.
 */
export function toWorkTask(t, expired, board) {
    const i = t.inbox;
    const phase = phaseOf(t.status, expired);
    const fromBoard = i?.boardId ? board?.get(i.boardId) : undefined;
    const priority = i?.priority ?? fromBoard?.priority;
    return {
        id: t.taskId,
        title: t.title,
        status: t.status,
        phase,
        worker: workerOf(t),
        ...(i?.model ? { model: i.model } : {}),
        ...(i?.kind ? { kind: i.kind } : {}),
        ...(i?.steps ? { steps: i.steps } : {}),
        ...(i?.estSteps ? { estSteps: i.estSteps } : {}),
        ...(i?.startedAt ? { startedAt: i.startedAt } : {}),
        ...(i?.endedAt ? { endedAt: i.endedAt } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(i?.queuePos ? { queuePos: i.queuePos } : {}),
        ...(i?.boardId ? { boardId: i.boardId } : {}),
        at: i?.at || t.createdAt,
        ...(phase === "failed" ? { cause: i?.cause ?? t.line } : {}),
        expired,
    };
}
/** The worker an agent run belongs to, by where it comes from (a chat's helper runs on the local model). */
export function workerOfRun(c) {
    switch (c.state.source) {
        case "antigravity":
            return "antigravity";
        case "claude-cloud":
        case "claude-chat":
            return "claude";
        default:
            return "local";
    }
}
/** An agent run as the work views use it (no kind: a run does not say what it is). */
export function runToWorkTask(c) {
    const s = c.state;
    return {
        id: `${c.deviceId}/${c.runId}`,
        title: s.name || s.title,
        status: s.state,
        phase: phaseOf(s.state),
        worker: workerOfRun(c),
        ...(s.model ? { model: s.model } : {}),
        ...(s.step ? { steps: s.step } : {}),
        ...(s.of ? { estSteps: s.of } : {}),
        ...(s.startedAt ? { startedAt: s.startedAt } : {}),
        ...(s.endedAt ? { endedAt: s.endedAt } : {}),
        at: s.endedAt ?? c.at,
        ...(s.state === "failed" && s.summary ? { cause: s.summary } : {}),
        expired: false,
    };
}
const WAITING = new Set(["waiting", "waiting-run", "deferred"]);
const rank = (n) => n ?? Number.POSITIVE_INFINITY;
/**
 * The tasks that wait for a worker, in the order they will be taken: a deferred one (it cannot start before its
 * quota resets) after the others, then the board's priority (lower is more urgent), then the queue order the PC
 * reports, then the oldest first. Board items that no inbox task stands for join (the local agent takes them); a
 * board item that waits on Roee himself does not.
 *
 * @param tasks - The page's tasks as work tasks (all phases; only the waiting ones count).
 * @param board - The PCs' board items (all statuses).
 * @returns The list, first to be taken first.
 */
export function nextEntries(tasks, board = []) {
    const out = [];
    const onBoard = new Set();
    for (const t of tasks) {
        if (t.phase !== "active" || !WAITING.has(t.status))
            continue;
        if (t.boardId)
            onBoard.add(t.boardId);
        out.push({ id: t.id, from: "task", title: t.title, worker: t.worker, ...(t.model ? { model: t.model } : {}), ...(t.priority !== undefined ? { priority: t.priority } : {}), ...(t.queuePos ? { queuePos: t.queuePos } : {}), needsRun: t.status === "waiting-run", deferred: t.status === "deferred", ...(t.estSteps ? { estSteps: t.estSteps } : {}), ...(t.kind ? { kind: t.kind } : {}), at: t.at });
    }
    for (const i of board) {
        if (i.status !== "open" || onBoard.has(i.id))
            continue;
        const who = boardWho(i);
        if (who === "roee")
            continue;
        out.push({ id: i.id, from: "board", title: i.title, worker: who === "kesher" ? "local" : "claude", priority: i.priority, needsRun: false, deferred: false, at: i.at });
    }
    return out.sort((a, b) => Number(a.deferred) - Number(b.deferred) || rank(a.priority) - rank(b.priority) || rank(a.queuePos) - rank(b.queuePos) || a.at - b.at || a.id.localeCompare(b.id));
}
/**
 * The Now strip: one row per worker, in the order of {@link WORKERS} (a worker with several jobs gets several rows; one
 * with none says "free", except Claude, which is listed only when something of it is reported). A running task shows
 * its live run's step and model when the run is known; a run that no task stands for (a helper, the Claude chat) and a
 * board item taken by Claude or by self-work are rows of their own. A run that only waits for Run is not working.
 *
 * @param tasks - The page's tasks as work tasks, with their inbox runs: `runKey` by task id.
 * @param cards - The live agent runs.
 * @param board - The PCs' board items.
 * @param now - Now (ms).
 * @param runKeyOf - The live run's key (`device/run`) of a task, when it has one.
 * @returns The rows.
 */
export function nowRows(tasks, cards, board, now, runKeyOf = () => undefined) {
    const byKey = new Map();
    for (const c of cards)
        byKey.set(`${c.deviceId}/${c.runId}`, c);
    const rows = [];
    const linked = new Set();
    const running = new Set();
    for (const t of tasks) {
        if (t.status !== "running")
            continue;
        if (t.boardId)
            running.add(t.boardId);
        const key = runKeyOf(t.id);
        const c = key ? byKey.get(key) : undefined;
        if (key)
            linked.add(key);
        const st = c ? shownState(c, now) : undefined;
        const steps = c?.state.step || t.steps;
        const of = c?.state.of || t.estSteps;
        const model = c?.state.model ?? t.model;
        const since = c?.state.startedAt || t.startedAt || t.at;
        rows.push({ worker: t.worker, free: false, title: t.title, ...(steps ? { step: steps } : {}), ...(of ? { of } : {}), ...(model ? { model } : {}), ...(since ? { since } : {}), ...(st === "waiting" || st === "stale" ? { flag: st } : {}), ...(key && c ? { runKey: key } : {}), taskId: t.id });
    }
    for (const [key, c] of byKey) {
        const st = shownState(c, now);
        if (linked.has(key) || !isGoing(c) || st === "queued")
            continue;
        // Antigravity waiting for Run has not started: it is in the Next list, not working.
        if (c.state.state === "waiting" && c.state.waiting?.reason === "run-press")
            continue;
        const s = c.state;
        rows.push({ worker: workerOfRun(c), free: false, title: s.name || s.title, ...(s.step ? { step: s.step } : {}), ...(s.of ? { of: s.of } : {}), ...(s.model ? { model: s.model } : {}), ...(s.startedAt ? { since: s.startedAt } : {}), ...(st === "waiting" || st === "stale" ? { flag: st } : {}), runKey: key });
    }
    for (const i of board) {
        if (i.status !== "claimed" || running.has(i.id))
            continue;
        const who = boardWho(i);
        if (who === "roee")
            continue;
        rows.push({ worker: who === "kesher" ? "local" : "claude", free: false, title: i.title, since: i.at });
    }
    const order = (w) => {
        const n = WORKERS.indexOf(w);
        return n < 0 ? WORKERS.length : n;
    };
    const out = rows.sort((a, b) => order(a.worker) - order(b.worker) || (a.since ?? 0) - (b.since ?? 0));
    for (const w of WORKERS)
        if (w !== "claude" && !out.some((r) => r.worker === w))
            out.push({ worker: w, free: true });
    return out.sort((a, b) => order(a.worker) - order(b.worker) || (a.since ?? 0) - (b.since ?? 0));
}
/** No filter. */
export const NO_FILTERS = { who: [], model: "", kind: "" };
/**
 * The saved filters from untrusted input (the browser's storage): anything odd is dropped, never trusted.
 *
 * @param x - The saved value.
 * @returns Valid filters.
 */
export function cleanFilters(x) {
    if (!x || typeof x !== "object")
        return { ...NO_FILTERS, who: [] };
    const o = x;
    const word = /^[a-z][a-z-]{0,23}$/;
    const who = Array.isArray(o.who) ? [...new Set(o.who.filter((w) => typeof w === "string" && word.test(w)))].slice(0, 12) : [];
    const model = typeof o.model === "string" ? o.model.slice(0, 60) : "";
    const kind = HUB_WORK_KINDS.find((k) => k === o.kind) ?? "";
    return { who, model, kind };
}
/** Whether any filter is on. */
export const filtersOn = (f) => f.who.length > 0 || !!f.model || !!f.kind;
/**
 * Whether something passes the filters. A filter by kind hides what has no kind (a live run does not say what it is).
 *
 * @param t - The task or run.
 * @param f - The filters.
 * @param skip - A dimension to ignore (to count what a chip would show).
 */
export function passes(t, f, skip) {
    if (skip !== "who" && f.who.length && !f.who.includes(t.worker))
        return false;
    if (skip !== "model" && f.model && t.model !== f.model)
        return false;
    if (skip !== "kind" && f.kind && t.kind !== f.kind)
        return false;
    return true;
}
/** The distinct model names seen on tasks and runs, sorted. */
export function modelsOf(items) {
    return [...new Set(items.map((t) => t.model).filter((m) => !!m))].sort((a, b) => a.localeCompare(b));
}
/** How many items each tab holds (the counts on Active · Done · Failed). */
export function phaseCounts(items) {
    const n = { active: 0, done: 0, failed: 0 };
    for (const t of items)
        n[t.phase]++;
    return n;
}
/**
 * The order of a tab's list: Active: running first, then the Next order; Done and Failed: the newest end first.
 *
 * @param phase - The tab.
 * @returns A comparator.
 */
export function listOrder(phase) {
    if (phase !== "active")
        return (a, b) => (b.endedAt ?? b.at) - (a.endedAt ?? a.at) || a.id.localeCompare(b.id);
    const live = (t) => (t.status === "running" ? 0 : t.status === "waiting" && t.worker !== "local" ? 1 : 2);
    return (a, b) => live(a) - live(b) || Number(a.status === "deferred") - Number(b.status === "deferred") || rank(a.priority) - rank(b.priority) || rank(a.queuePos) - rank(b.queuePos) || a.at - b.at || a.id.localeCompare(b.id);
}
/**
 * The rows that were in the Active list at the last draw and no longer are (they ended while the owner looked): the
 * page keeps each one for a moment and animates it out instead of letting the list jump under the finger.
 *
 * @param before - The ids the Active list showed.
 * @param after - The ids it shows now.
 * @returns The ids that left.
 */
export function leavers(before, after) {
    return [...before].filter((id) => !after.has(id));
}
