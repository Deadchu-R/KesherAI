/**
 * The hub's "Task chat" (Roee, 27.11): a chat on the hub's Tasks page (and the phone) whose only job is organising the
 * task board, answered by a small model on the PC's processor (cpu-pool.ts, role `chat`).
 *
 * The hub never sees the text: the owner's page seals a {@link TaskChatAsk} to the PC (kind `taskchat`) and the PC seals
 * a {@link TaskChatAnswer} back (kind `taskchat_answer`), like `command` and `command_result`. The model only PROPOSES:
 * its reply is mapped to a short fixed list of {@link TaskChatAction}s by {@link parseModelReply} (anything else is
 * refused), the page shows them as a card, and nothing changes until the owner presses Apply (a second sealed ask that
 * names the proposal's id; the PC applies what it kept, never what the page sends).
 *
 * Plain data and validators only (no Node or browser API): the Worker, the PC and the page share this copy.
 */
import { parseAssignTo } from "./task-assign.js";
/** Limits of the task chat (the sealed answer stays far under the envelope cap). */
export const TASK_CHAT_LIMITS = {
    /** What the owner types, in characters. */
    textChars: 600,
    /** A reply's text. */
    replyChars: 700,
    /** Tasks in the board context, and the context's whole size (the small model's window is short). */
    boardTasks: 30,
    boardChars: 3500,
    /** A task's title in the context and in a card. */
    titleChars: 80,
    /** A new task's title and goal. */
    newTitleChars: 120,
    newGoalChars: 600,
    /** Actions one proposal may hold, and parts one split may make. */
    actions: 8,
    parts: 6,
    /** Proposals the PC keeps for Apply, and for how long (ms). */
    keepProposals: 12,
    keepMs: 30 * 60_000,
    /** Asks a PC takes in a minute. */
    perMinute: 12,
    /** The model's answer, in tokens. */
    maxTokens: 400,
};
/** The executors a new task or "Who does it" may name in this chat (a short list a small model can hold). */
export const TASK_CHAT_EXECUTORS = ["auto", "antigravity", "local", "gemini", "opencode", "ghostcli", "opus"];
/** Every action's `op`. */
export const TASK_CHAT_OPS = ["add", "split", "assign", "queue", "unqueue", "skip"];
/** States a task may be skipped in (it has not started), and states "Who does it" / queue may touch. */
const SKIPPABLE = new Set(["waiting", "queued", "needs-approval", "deferred-quota"]);
const ASSIGNABLE = new Set(["waiting", "queued", "needs-approval", "deferred-quota", "failed", "partial"]);
const QUEUABLE = new Set(["waiting", "deferred-quota"]);
/** The system prompt: short, Hebrew and English, the JSON shape and the few rules (a small model follows little). */
export const TASK_CHAT_SYSTEM = [
    "You organise a task board. Reply with ONE JSON object only, no other text:",
    '{"reply":"short answer in the user\'s language","actions":[...]}',
    "actions (at most 8), each one of:",
    '{"op":"add","title":"...","executor":"auto"}',
    '{"op":"split","id":3,"parts":["step 1","step 2"]}  (new tasks replace task 3, which is skipped)',
    '{"op":"assign","id":3,"to":"local"}  to: antigravity, local, gemini, opencode, ghostcli, claude, claude-code',
    '{"op":"queue","id":3} {"op":"unqueue","id":3} {"op":"skip","id":3}  (skip = close a duplicate or unwanted task)',
    "id is the task's number in the board below. Never invent a number. Only change what the user asked. No code, no commands.",
    "אתה מארגן לוח משימות. ענה באובייקט JSON אחד בלבד, באותה שפה של המשתמש בשדה reply. אם אין שינוי, actions ריק.",
].join("\n");
/**
 * The board as the model sees it: one line per task (`number | title | executor | state`), open tasks first, capped in
 * count and size. Returns the text and the ids by number (number 1 = `ids[0]`).
 *
 * @param tasks - The inbox's tasks, oldest first.
 */
export function boardContext(tasks) {
    const open = (t) => !["done", "skipped", "declined"].includes(t.state);
    const picked = [...tasks.filter(open), ...tasks.filter((t) => !open(t)).reverse()].slice(0, TASK_CHAT_LIMITS.boardTasks);
    const lines = [];
    const kept = [];
    let size = 0;
    for (const t of picked) {
        const line = `${kept.length + 1} | ${clean(t.title, TASK_CHAT_LIMITS.titleChars)} | ${t.executor} | ${t.state}`;
        if (size + line.length + 1 > TASK_CHAT_LIMITS.boardChars)
            break;
        size += line.length + 1;
        lines.push(line);
        kept.push(t);
    }
    return { text: lines.length ? lines.join("\n") : "(empty board)", ids: kept.map((t) => t.taskId), tasks: kept };
}
/** One line of text: control characters and runs of spaces collapsed, cut at `max`. */
function clean(s, max) {
    return (typeof s === "string" ? s : "").replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
/** The first balanced `{...}` of a text (a small model may wrap its JSON in prose or a code fence), or undefined. */
function firstObject(raw) {
    const start = raw.indexOf("{");
    if (start < 0)
        return undefined;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < raw.length; i++) {
        const c = raw[i];
        if (inStr) {
            if (c === "\\")
                i++;
            else if (c === '"')
                inStr = false;
        }
        else if (c === '"')
            inStr = true;
        else if (c === "{")
            depth++;
        else if (c === "}" && --depth === 0)
            return raw.slice(start, i + 1);
    }
    return undefined;
}
/**
 * Maps the model's text to actions. Invalid JSON gives `ok: false` and no actions. Every action is checked against
 * the board the model was shown: a task number must exist, and the change must fit the task's state; a new title is
 * cleaned and cut; executors outside the fixed list are refused.
 *
 * @param raw - The model's text.
 * @param board - The context from {@link boardContext} (its tasks, in number order).
 * @returns The reply and the valid actions (at most {@link TASK_CHAT_LIMITS.actions}).
 */
export function parseModelReply(raw, board) {
    const json = firstObject(typeof raw === "string" ? raw : "");
    let obj;
    try {
        obj = json ? JSON.parse(json) : undefined;
    }
    catch {
        obj = undefined;
    }
    if (!obj || typeof obj !== "object")
        return { ok: false, reply: "", actions: [], refused: 0 };
    const o = obj;
    const reply = clean(o.reply, TASK_CHAT_LIMITS.replyChars);
    const list = Array.isArray(o.actions) ? o.actions : [];
    const actions = [];
    let refused = 0;
    const seen = new Set();
    for (const a of list.slice(0, TASK_CHAT_LIMITS.actions * 2)) {
        const m = mapAction(a, board);
        if (!m) {
            refused++;
            continue;
        }
        // The same change twice (a small model repeats itself) counts once.
        const key = JSON.stringify(m);
        if (seen.has(key))
            continue;
        seen.add(key);
        if (actions.length < TASK_CHAT_LIMITS.actions)
            actions.push(m);
        else
            refused++;
    }
    return { ok: true, reply, actions, refused };
}
/** The executor a model named, or `auto`; undefined when it named one outside the list. */
function executorOf(v) {
    if (v === undefined || v === null || v === "")
        return "auto";
    return TASK_CHAT_EXECUTORS.includes(v) ? v : undefined;
}
/** One model action checked against the board, or undefined. */
function mapAction(a, board) {
    if (!a || typeof a !== "object")
        return undefined;
    const x = a;
    const op = x.op;
    if (op === "add") {
        const title = clean(x.title, TASK_CHAT_LIMITS.newTitleChars);
        const executor = executorOf(x.executor);
        if (!title || !executor)
            return undefined;
        const goal = clean(x.goal, TASK_CHAT_LIMITS.newGoalChars);
        return { op, title, ...(goal ? { goal } : {}), executor };
    }
    if (op !== "split" && op !== "assign" && op !== "queue" && op !== "unqueue" && op !== "skip")
        return undefined;
    const n = typeof x.id === "number" ? x.id : typeof x.id === "string" && /^\d{1,3}$/.test(x.id) ? Number(x.id) : NaN;
    const t = Number.isInteger(n) ? board[n - 1] : undefined;
    if (!t)
        return undefined;
    const title = clean(t.title, TASK_CHAT_LIMITS.titleChars);
    if (op === "assign") {
        const to = parseAssignTo(x.to);
        return to && ASSIGNABLE.has(t.state) ? { op, taskId: t.taskId, title, to } : undefined;
    }
    if (op === "queue")
        return QUEUABLE.has(t.state) ? { op, taskId: t.taskId, title } : undefined;
    if (op === "unqueue")
        return t.state === "queued" ? { op, taskId: t.taskId, title } : undefined;
    if (op === "skip")
        return SKIPPABLE.has(t.state) ? { op, taskId: t.taskId, title } : undefined;
    // split: two or more parts, each a title (or {title, goal}); the original must not have started.
    if (!SKIPPABLE.has(t.state) || !Array.isArray(x.parts))
        return undefined;
    const parts = [];
    for (const p of x.parts.slice(0, TASK_CHAT_LIMITS.parts)) {
        const o = typeof p === "string" ? { title: p } : p && typeof p === "object" ? p : {};
        const pt = clean(o.title, TASK_CHAT_LIMITS.newTitleChars);
        const goal = clean(o.goal, TASK_CHAT_LIMITS.newGoalChars);
        if (pt)
            parts.push({ title: pt, ...(goal ? { goal } : {}) });
    }
    return parts.length >= 2 ? { op, taskId: t.taskId, title, parts, executor: executorOf(x.executor) ?? "auto" } : undefined;
}
const ID = /^[\w-]{1,64}$/;
/**
 * Checks an ask from the page (the PC repeats it: the page is not trusted).
 *
 * @param x - Untrusted input.
 */
export function parseTaskChatAsk(x) {
    if (!x || typeof x !== "object")
        return undefined;
    const b = x;
    if (typeof b.chatId !== "string" || !ID.test(b.chatId) || (b.op !== "say" && b.op !== "apply" && b.op !== "cancel"))
        return undefined;
    const at = typeof b.at === "number" && Number.isFinite(b.at) ? b.at : 0;
    if (b.op === "say") {
        const text = clean(b.text, TASK_CHAT_LIMITS.textChars);
        return text ? { chatId: b.chatId, op: "say", text, at } : undefined;
    }
    return typeof b.proposalId === "string" && ID.test(b.proposalId) ? { chatId: b.chatId, op: b.op, proposalId: b.proposalId, at } : undefined;
}
/** Re-checks one action received from a PC (shape and sizes only; the page shows it, the PC applies its own copy). */
function cleanAction(a) {
    if (!a || typeof a !== "object")
        return undefined;
    const x = a;
    const title = clean(x.title, TASK_CHAT_LIMITS.newTitleChars);
    if (!title || !TASK_CHAT_OPS.includes(x.op))
        return undefined;
    if (x.op === "add") {
        const executor = executorOf(x.executor);
        return executor ? { op: "add", title, executor, ...(clean(x.goal, TASK_CHAT_LIMITS.newGoalChars) ? { goal: clean(x.goal, TASK_CHAT_LIMITS.newGoalChars) } : {}) } : undefined;
    }
    if (typeof x.taskId !== "string" || !ID.test(x.taskId))
        return undefined;
    if (x.op === "assign") {
        const to = parseAssignTo(x.to);
        return to ? { op: "assign", taskId: x.taskId, title, to } : undefined;
    }
    if (x.op === "split") {
        const parts = (Array.isArray(x.parts) ? x.parts : []).slice(0, TASK_CHAT_LIMITS.parts).flatMap((p) => {
            const o = p && typeof p === "object" ? p : {};
            const pt = clean(o.title, TASK_CHAT_LIMITS.newTitleChars);
            return pt ? [{ title: pt }] : [];
        });
        return parts.length >= 2 ? { op: "split", taskId: x.taskId, title, parts, executor: executorOf(x.executor) ?? "auto" } : undefined;
    }
    return { op: x.op, taskId: x.taskId, title };
}
/**
 * Checks an answer from a PC.
 *
 * @param x - Untrusted input.
 */
export function parseTaskChatAnswer(x) {
    if (!x || typeof x !== "object")
        return undefined;
    const b = x;
    if (typeof b.chatId !== "string" || !ID.test(b.chatId))
        return undefined;
    const kind = b.kind === "reply" || b.kind === "applied" || b.kind === "cancelled" || b.kind === "refused" ? b.kind : undefined;
    if (!kind)
        return undefined;
    const text = clean(b.text, TASK_CHAT_LIMITS.replyChars) || (kind === "reply" ? "…" : kind);
    const out = { chatId: b.chatId, kind, text };
    const p = b.proposal && typeof b.proposal === "object" ? b.proposal : undefined;
    if (p && typeof p.id === "string" && ID.test(p.id) && Array.isArray(p.actions)) {
        const actions = p.actions.slice(0, TASK_CHAT_LIMITS.actions).map(cleanAction).filter((a) => !!a);
        if (actions.length)
            out.proposal = { id: p.id, actions };
    }
    if (typeof b.proposalId === "string" && ID.test(b.proposalId))
        out.proposalId = b.proposalId;
    if (typeof b.done === "number" && Number.isFinite(b.done))
        out.done = Math.max(0, Math.min(99, Math.floor(b.done)));
    if (typeof b.failed === "number" && Number.isFinite(b.failed))
        out.failed = Math.max(0, Math.min(99, Math.floor(b.failed)));
    return out;
}
/**
 * Whether an ask is too old (or has no time): the PC refuses it, so one captured and delivered again does nothing.
 *
 * @param at - When the page asked (ms).
 * @param now - The PC's clock (ms).
 * @returns True when it must be refused.
 */
export function taskChatStale(at, now) {
    return !(at > 0) || Math.abs(now - at) > 5 * 60_000;
}
