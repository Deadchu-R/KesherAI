import { cleanProviderQuotas } from "./provider-quotas.js";
import { parseAssignTo } from "./task-assign.js";
export const CONNECTOR_OPS = ["tasks", "task", "quotas", "agents", "add", "action"];
export const CONNECTOR_ACTIONS = ["run", "queue", "unqueue", "stop", "assign"];
/** Executors a new task may name (`auto`: the PC's own routing, the same as "+ Task"). */
export const CONNECTOR_EXECUTORS = ["auto", "antigravity", "local", "opus", "gemini", "opencode", "ghostcli"];
/** Limits of the connector's line (the sealed answer must stay under the envelope cap: about 12 KB of plain text). */
export const CONNECTOR_LIMITS = {
    /** Tasks one `tasks` answer lists. */
    tasks: 30,
    /** Steps one `task` answer carries (the newest). */
    steps: 12,
    /** Agents one `agents` answer lists. */
    agents: 16,
    /** A new task's goal, in characters (the inbox's own cap). */
    goalChars: 6000,
    /** A row's title in a list. */
    titleChars: 120,
    /** The plain answer, in characters, before it is sealed. */
    answerChars: 10_000,
    /** How long the hub waits for the PC's answer. */
    waitMs: 10_000,
    /** Queries a PC takes in a minute (and the hub sends per connection). */
    perMinute: 30,
};
const ID = /^[\w-]{1,64}$/;
/** A string, on one line (newlines, tabs and other control characters become spaces), cut to `max`. */
const str = (v, max) => (typeof v === "string" ? v : "").replace(/[\p{Cc}]+/gu, " ").slice(0, max);
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
const optStr = (k, v, max) => {
    const s = str(v, max).trim();
    return s ? { [k]: s } : {};
};
const optNum = (k, v) => {
    const n = num(v);
    return n !== undefined ? { [k]: n } : {};
};
/**
 * Checks a query (on the PC after opening it, and on the hub before sealing it).
 *
 * @param x - Untrusted input.
 * @returns The query, or null when its op, ids or fields are not allowed.
 */
export function parseConnectorQuery(x) {
    if (!x || typeof x !== "object")
        return null;
    const q = x;
    if (typeof q.queryId !== "string" || !ID.test(q.queryId) || !CONNECTOR_OPS.includes(q.op))
        return null;
    const base = { queryId: q.queryId, op: q.op };
    switch (base.op) {
        case "tasks": {
            const filter = ["open", "running", "ended", "all"].find((f) => f === q.filter) ?? "all";
            const executor = typeof q.executor === "string" && /^[a-z][a-z-]{0,23}$/.test(q.executor) ? q.executor : undefined;
            return { ...base, filter, ...(executor ? { executor } : {}) };
        }
        case "task":
            return typeof q.taskId === "string" && ID.test(q.taskId) ? { ...base, taskId: q.taskId } : null;
        case "quotas":
        case "agents":
            return base;
        case "add": {
            const title = str(q.title, 200).trim();
            // The goal keeps its lines (other control characters become spaces).
            const goal = (typeof q.goal === "string" ? q.goal : "").replace(/\p{Cc}/gu, (c) => (c === "\n" || c === "\t" ? c : " ")).slice(0, CONNECTOR_LIMITS.goalChars).trim();
            if (!title)
                return null;
            const executor = CONNECTOR_EXECUTORS.find((e) => e === q.executor) ?? "auto";
            return { ...base, title, goal: goal || title, executor };
        }
        case "action": {
            if (typeof q.taskId !== "string" || !ID.test(q.taskId) || !CONNECTOR_ACTIONS.includes(q.action))
                return null;
            const action = q.action;
            if (action !== "assign")
                return { ...base, taskId: q.taskId, action };
            const to = parseAssignTo(q.to);
            return to ? { ...base, taskId: q.taskId, action, to, ...(q.confirm === true ? { confirm: true } : {}) } : null;
        }
    }
}
/** A step note from untrusted input (tool and target short, one line). */
function cleanStep(x) {
    if (!x || typeof x !== "object")
        return undefined;
    const s = x;
    const tool = str(s.tool, 40).trim();
    if (!tool)
        return undefined;
    return { tool, ...optStr("target", s.target, 120), at: num(s.at) ?? 0, ...(s.error === true ? { error: true } : {}) };
}
/** A task row from untrusted input. */
function cleanRow(x) {
    if (!x || typeof x !== "object")
        return undefined;
    const r = x;
    if (typeof r.taskId !== "string" || !ID.test(r.taskId))
        return undefined;
    const title = str(r.title, CONNECTOR_LIMITS.titleChars).trim() || r.taskId;
    const state = /^[a-z-]{1,16}$/.test(String(r.state)) ? String(r.state) : "waiting";
    const executor = /^[a-z][a-z-]{0,23}$/.test(String(r.executor)) ? String(r.executor) : "claude";
    return { taskId: r.taskId, title, state, executor, ...optNum("queuePos", r.queuePos), ...optNum("steps", r.steps), ...optNum("estSteps", r.estSteps), ...optStr("model", r.model, 60) };
}
/**
 * Checks an answer (on the hub after opening it): fields capped, unknown ones dropped.
 *
 * @param x - The decrypted JSON.
 * @returns The answer, or null when it has no query id.
 */
export function parseConnectorAnswer(x) {
    if (!x || typeof x !== "object")
        return null;
    const a = x;
    if (typeof a.queryId !== "string" || !ID.test(a.queryId))
        return null;
    const out = { queryId: a.queryId, ok: a.ok === true, ...optStr("text", a.text, 300), at: num(a.at) ?? 0 };
    if (Array.isArray(a.tasks))
        out.tasks = a.tasks.slice(0, CONNECTOR_LIMITS.tasks).map(cleanRow).filter((r) => !!r);
    if (a.task && typeof a.task === "object") {
        const t = a.task;
        const row = cleanRow({ ...t, title: str(t.title, 200) });
        if (row) {
            const steps = Array.isArray(t.stepLog) ? t.stepLog.slice(-CONNECTOR_LIMITS.steps).map(cleanStep).filter((s) => !!s) : [];
            out.task = { ...row, title: str(t.title, 200).trim() || row.title, ...optStr("branch", t.branch, 200), ...optStr("result", t.result, 300), ...optStr("cause", t.cause, 160), ...optStr("kind", t.kind, 20), ...optNum("startedAt", t.startedAt), ...optNum("endedAt", t.endedAt), stepLog: steps };
        }
    }
    if (Array.isArray(a.quotas))
        out.quotas = cleanProviderQuotas(a.quotas);
    if (Array.isArray(a.agents)) {
        out.agents = a.agents.slice(0, CONNECTOR_LIMITS.agents).flatMap((g) => {
            if (!g || typeof g !== "object")
                return [];
            const r = g;
            const kind = str(r.kind, 40);
            if (!/^[a-z0-9-]{1,40}$/.test(kind))
                return [];
            const t = r.task && typeof r.task === "object" ? r.task : undefined;
            const task = t && typeof t.taskId === "string" && ID.test(t.taskId) ? { taskId: t.taskId, title: str(t.title, CONNECTOR_LIMITS.titleChars).trim() || t.taskId, ...optNum("steps", t.steps), ...optNum("estSteps", t.estSteps), ...(cleanStep(t.now) ? { now: cleanStep(t.now) } : {}) } : undefined;
            return [{ kind, state: /^[a-z-]{1,12}$/.test(String(r.state)) ? String(r.state) : "off", ...optStr("label", r.label, 60), ...(task ? { task } : {}) }];
        });
    }
    return out;
}
/**
 * Makes an answer fit the sealed envelope: drops the oldest list rows and steps until its JSON is under
 * {@link CONNECTOR_LIMITS.answerChars}, and says how many rows were left out.
 *
 * @param a - The answer.
 * @returns The same answer, small enough to seal.
 */
export function fitConnectorAnswer(a) {
    const out = { ...a, ...(a.tasks ? { tasks: [...a.tasks] } : {}), ...(a.task ? { task: { ...a.task, stepLog: [...a.task.stepLog] } } : {}), ...(a.quotas ? { quotas: [...a.quotas] } : {}) };
    let cut = 0;
    const size = () => JSON.stringify(out).length;
    // Room for the "left out" note added below.
    while (size() > CONNECTOR_LIMITS.answerChars - 60) {
        if (out.tasks?.length) {
            out.tasks.shift();
            cut++;
        }
        else if (out.task?.stepLog.length)
            out.task.stepLog.shift();
        else if (out.quotas?.length)
            out.quotas.pop();
        else if (out.agents?.length)
            out.agents.pop();
        else
            break;
    }
    if (cut)
        out.text = `${cut} older task(s) left out.`;
    return out;
}
/** The hub's task states that count as "open", "running" and "ended" for {@link ConnectorFilter}. */
export const CONNECTOR_FILTER_STATES = {
    open: ["waiting", "waiting-run", "deferred"],
    running: ["running"],
    ended: ["done", "partial", "failed"],
};
/**
 * Runs every text field of an answer through `fn` (ids, states and numbers are left alone): the PC hides its home
 * folder, user name and keys with it before sealing, and the hub runs its own scrub again before Claude sees it.
 *
 * @param a - The answer.
 * @param fn - The scrub, e.g. `(s) => redactLeaks(s).text`.
 * @returns A new answer with clean text.
 */
export function mapConnectorText(a, fn) {
    const row = (r) => ({ ...r, title: fn(r.title), ...(r.model ? { model: fn(r.model) } : {}) });
    const step = (s) => ({ ...s, tool: fn(s.tool), ...(s.target ? { target: fn(s.target) } : {}) });
    return {
        ...a,
        ...(a.text ? { text: fn(a.text) } : {}),
        ...(a.tasks ? { tasks: a.tasks.map(row) } : {}),
        ...(a.task
            ? { task: { ...row(a.task), ...(a.task.branch ? { branch: fn(a.task.branch) } : {}), ...(a.task.result ? { result: fn(a.task.result) } : {}), ...(a.task.cause ? { cause: fn(a.task.cause) } : {}), stepLog: a.task.stepLog.map(step) } }
            : {}),
        ...(a.quotas ? { quotas: a.quotas.map((q) => ({ ...q, name: fn(q.name), ...(q.model ? { model: fn(q.model) } : {}), ...(q.health ? { health: { ...q.health, model: fn(q.health.model) } } : {}), ...(q.movedTo ? { movedTo: q.movedTo.map((m) => ({ ...m, name: fn(m.name) })) } : {}) })) } : {}),
        ...(a.agents
            ? { agents: a.agents.map((g) => ({ ...g, ...(g.label ? { label: fn(g.label) } : {}), ...(g.task ? { task: { ...g.task, title: fn(g.task.title), ...(g.task.now ? { now: step(g.task.now) } : {}) } } : {}) })) }
            : {}),
    };
}
