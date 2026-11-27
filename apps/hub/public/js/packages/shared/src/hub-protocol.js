/**
 * Kesher Cloud hub: the wire protocol between the hub (a Cloudflare Worker) and the paired devices (PCs, the phone).
 * The hub is a thin relay (docs/RESEARCH_LOG.md, "Kesher Cloud hub" and its addendum): it sees presence and routing
 * metadata only; every task, result and approval travels as a {@link SealedEnvelope} the hub cannot read. The one
 * exception is a message sealed to the hub itself (`to: "hub"`, kind `cloud`) for the Claude cloud path.
 *
 * Everything here is plain data and small validators, with no Node or browser API, so the Worker, the PC (core) and
 * the phone page share one copy.
 */
import { cleanAgentLabel } from "./agent-label.js";
import { parseAssignTo } from "./task-assign.js";
import { cleanAwayNote } from "./device-status.js";
import { cleanTailscaleDirect } from "./direct-path.js";
import { cleanRelayKeys } from "./relay-keys.js";
import { cleanProviderQuotas } from "./provider-quotas.js";
import { parseTaskChatAnswer, parseTaskChatAsk } from "./hub-task-chat.js";
import { parseConnectorAnswer, parseConnectorQuery } from "./hub-connector.js";
/** The protocol version every frame and envelope carries. */
export const HUB_PROTOCOL = 1;
/** Size and time limits shared by both sides. */
export const HUB_LIMITS = {
    /** Largest sealed ciphertext, in base64url characters (about 12 KB of plain text). */
    ctChars: 16 * 1024,
    /** Largest frame the hub reads from a socket or a request body, in characters. */
    frameChars: 20 * 1024,
    /** A task's spec. */
    specChars: 8000,
    /** A result's text. */
    resultChars: 4000,
    /** A task title, a device name. */
    titleChars: 200,
    nameChars: 60,
    /** A vendor session link. */
    linkChars: 500,
    /** Agents one device may report. */
    agents: 16,
    /** Default, longest and approval lifetimes of a queued message, in seconds. */
    defaultTtl: 24 * 3600,
    maxTtl: 7 * 24 * 3600,
    approvalTtl: 30 * 60,
    /** Live agent activity: events in one batch, runs in one `agents` frame, events the hub keeps per run and for how long. */
    agentBatchEvents: 20,
    agentFrameEnvs: 16,
    agentEventsPerRun: 50,
    /** Agent-event rows the hub keeps in all (oldest evicted first): bounds a misbehaving PC within the free plan's writes. */
    agentEventsTotal: 2000,
    agentKeepMs: 7 * 24 * 3600 * 1000,
    /** A running agent's heartbeat, and how long without one before a viewer shows it as stale (the Cursor freeze lesson). */
    agentBeatMs: 25_000,
    agentStaleMs: 90_000,
    /**
     * A Claude-chat run (`tools/hub-report`) has no heartbeat: the lead reports start and end only, and its helper
     * agents run for minutes, so it is shown as stale only after an hour without a report.
     */
    agentChatStaleMs: 3_600_000,
    /**
     * The content-free `sync` ping (a device wrote to Google Drive; the others pull now): one per device per this gap.
     * Devices hold back pings sent sooner ({@link syncPinger}); the hub drops what still comes faster.
     */
    syncPingMs: 5000,
    /** The approvals a PC lists for the hub page at once, and the plain text one snapshot may hold (to fit {@link ctChars}). */
    approvalItems: 8,
    approvalsChars: 10_000,
    /** The shared task board a PC reports: active items (open, taken, blocked), the newest done ones, and one snapshot's plain text. */
    boardActive: 60,
    boardDone: 20,
    boardChars: 10_000,
    /** A note from the hub page onto a board task, in characters. */
    boardNoteChars: 1000,
    /** The longest "Allow for a while" from the hub page, in minutes (a day, as on the PC's own card). */
    approvalForMaxMin: 24 * 60,
    /** The largest `ask_note` ciphertext (it rides in a Web Push payload, at most about 4 KB in all). */
    noteCtChars: 1500,
    /** An `ask_note`'s title, in characters (a notification line). */
    noteTitleChars: 80,
};
/**
 * The device kind a pairing request asks for (anything unknown is a PC, as before the kind existed).
 *
 * @param x - Untrusted input.
 * @returns The kind.
 */
export function cleanDeviceKind(x) {
    return x === "phone" || x === "claude-chat" ? x : "pc";
}
const SEALED_KINDS = ["task", "progress", "result", "cancel", "approval_request", "approval_answer", "cloud", "cloud_started", "agent_event", "inbox_task", "approvals", "command", "command_result", "ask_note", "board", "relays", "quotas", "claude_work", "connector_query", "connector_answer", "taskchat", "taskchat_answer"];
/** The opt-in a new PC starts with. */
export const DEFAULT_OPT_IN = { appear: true, acceptTasks: false, acceptLocal: false, acceptAntigravity: false, reportLinks: false, reportActivity: false, reportFileNames: false, connector: false };
const EXECUTORS = ["auto", "claude-cloud", "pc-local", "pc-antigravity", "pc-any"];
/**
 * Queue commands (task-inbox queue per executor, inbox-queue.ts): `inbox-queue` adds a task to its executor's line,
 * `inbox-unqueue` takes it out; `inbox-asknext` sets "ask before the next task" for the executor named in `taskId`
 * (`antigravity` or `local`) to `on`.
 */
export const HUB_COMMAND_ACTIONS = ["inbox-run", "inbox-cancel", "inbox-ask", "inbox-queue", "inbox-unqueue", "inbox-asknext", "agent-label", "assign", "board"];
/**
 * Fits a PC's approvals into one sealed snapshot: the newest {@link HUB_LIMITS.approvalItems}, fields capped, and
 * previews shortened until the whole is at most {@link HUB_LIMITS.approvalsChars} characters.
 *
 * @param items - Oldest first, as the PC lists them.
 * @returns The items to send, oldest first.
 */
export function fitApprovals(items) {
    const out = items.slice(-HUB_LIMITS.approvalItems).map((a) => cleanApproval(a)).filter((a) => !!a);
    for (const max of [600, 300, 120, 0]) {
        const cut = out.map((a) => ({ ...a, preview: a.preview.slice(0, max) }));
        if (JSON.stringify(cut).length <= HUB_LIMITS.approvalsChars || max === 0)
            return cut;
    }
    return out;
}
/**
 * Checks one approval of a snapshot (after opening it, or before sealing it).
 *
 * @param x - Untrusted input.
 * @returns The approval, or null.
 */
export function cleanApproval(x) {
    if (!x || typeof x !== "object")
        return null;
    const a = x;
    if (!isHubId(a.requestId) || !isHubId(a.conversationId))
        return null;
    const kind = a.kind === "run" ? "run" : "tool";
    return {
        requestId: a.requestId,
        conversationId: a.conversationId,
        title: str(a.title, 160).trim(),
        tool: str(a.tool, 80),
        ...optStr("who", a.who, 80),
        reason: str(a.reason, 300),
        preview: str(a.preview, 600),
        kind,
        ...(kind === "run" && a.next === true ? { next: true } : {}),
        forWhile: kind === "tool" && a.forWhile === true,
        at: num(a.at),
    };
}
/** The kinds a report may carry (anything else is dropped). */
export const HUB_WORK_KINDS = ["research", "code", "conversion"];
/** Which body type each envelope kind must hold (checked after opening, so a kind cannot be swapped). */
export const BODY_FOR_KIND = {
    task: "task",
    cloud: "task",
    progress: "progress",
    result: "result",
    cancel: "cancel",
    approval_request: "approval_request",
    approval_answer: "approval_answer",
    cloud_started: "cloud_started",
    agent_event: "agent_event",
    inbox_task: "inbox_task",
    approvals: "approvals",
    command: "command",
    command_result: "command_result",
    ask_note: "ask_note",
    board: "board",
    relays: "relays",
    quotas: "quotas",
    claude_work: "claude_work",
    connector_query: "connector_query",
    connector_answer: "connector_answer",
    taskchat: "taskchat",
    taskchat_answer: "taskchat_answer",
};
const ID = /^[\w-]{1,64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
/** @returns Whether `s` is an id the protocol accepts (letters, digits, `_`, `-`; 1-64). */
export function isHubId(s) {
    return typeof s === "string" && ID.test(s);
}
/**
 * Whether a link may be shown as a button: https only, no credentials in it, at most {@link HUB_LIMITS.linkChars}.
 *
 * @param s - The link.
 * @returns True when it is safe to show.
 */
export function isSafeLink(s) {
    if (typeof s !== "string" || s.length > HUB_LIMITS.linkChars)
        return false;
    try {
        const u = new URL(s);
        return u.protocol === "https:" && !u.username && !u.password;
    }
    catch {
        return false;
    }
}
const str = (v, max) => (typeof v === "string" ? v : "").slice(0, max);
const bool = (v, dflt) => (typeof v === "boolean" ? v : dflt);
/**
 * A clean opt-in from untrusted input (missing fields take the defaults).
 *
 * @param x - What the device sent.
 * @returns The opt-in.
 */
export function cleanOptIn(x) {
    const o = (x && typeof x === "object" ? x : {});
    return {
        appear: bool(o.appear, DEFAULT_OPT_IN.appear),
        acceptTasks: bool(o.acceptTasks, DEFAULT_OPT_IN.acceptTasks),
        acceptLocal: bool(o.acceptLocal, DEFAULT_OPT_IN.acceptLocal),
        acceptAntigravity: bool(o.acceptAntigravity, DEFAULT_OPT_IN.acceptAntigravity),
        reportLinks: bool(o.reportLinks, DEFAULT_OPT_IN.reportLinks),
        reportActivity: bool(o.reportActivity, DEFAULT_OPT_IN.reportActivity),
        reportFileNames: bool(o.reportFileNames, DEFAULT_OPT_IN.reportFileNames),
        connector: bool(o.connector, DEFAULT_OPT_IN.connector),
    };
}
/**
 * Clean agents from untrusted input: at most {@link HUB_LIMITS.agents}, short labels, and links only when they are
 * safe and the device's opt-in reports them.
 *
 * @param x - What the device sent.
 * @param reportLinks - The device's opt-in for vendor links.
 * @returns The agents.
 */
export function cleanAgents(x, reportLinks) {
    if (!Array.isArray(x))
        return [];
    const out = [];
    for (const a of x.slice(0, HUB_LIMITS.agents)) {
        if (!a || typeof a !== "object")
            continue;
        const r = a;
        const kind = str(r.kind, 40);
        if (!/^[a-z0-9-]{1,40}$/.test(kind))
            continue;
        const state = r.state === "on" || r.state === "busy" ? r.state : "off";
        const label = str(r.label, HUB_LIMITS.nameChars);
        out.push({ kind, state, ...(label ? { label } : {}), ...(reportLinks && isSafeLink(r.link) ? { link: r.link } : {}) });
    }
    return out;
}
/**
 * How long the hub may keep a message: the asked ttl clamped to the kind's maximum (approvals 30 minutes).
 *
 * @param kind - The envelope kind.
 * @param asked - Seconds the sender asked for.
 * @returns Seconds, at least 60.
 */
export function ttlFor(kind, asked) {
    const max = kind === "approval_request" || kind === "approval_answer" || kind === "approvals" || kind === "board" || kind === "command" || kind === "command_result" || kind === "ask_note" || kind === "relays" || kind === "quotas" || kind === "claude_work" || kind === "taskchat" || kind === "taskchat_answer" ? HUB_LIMITS.approvalTtl : kind === "connector_query" || kind === "connector_answer" ? 60 : HUB_LIMITS.maxTtl;
    const n = typeof asked === "number" && Number.isFinite(asked) ? Math.floor(asked) : HUB_LIMITS.defaultTtl;
    return Math.max(60, Math.min(max, n));
}
/**
 * Checks an envelope's shape (not its content: the hub cannot read that).
 *
 * @param x - Untrusted input.
 * @returns The envelope with its ttl clamped, or null when it is malformed or too big.
 */
export function parseEnvelope(x) {
    if (!x || typeof x !== "object")
        return null;
    const e = x;
    if (e.v !== HUB_PROTOCOL || !isHubId(e.id) || !isHubId(e.from) || !isHubId(e.to))
        return null;
    if (typeof e.kind !== "string" || !SEALED_KINDS.includes(e.kind))
        return null;
    if (typeof e.iv !== "string" || e.iv.length !== 16 || !B64URL.test(e.iv))
        return null;
    if (typeof e.ct !== "string" || !e.ct || e.ct.length > HUB_LIMITS.ctChars || !B64URL.test(e.ct))
        return null;
    const kind = e.kind;
    if (kind === "agent_event") {
        // The run id and the event count are the only plain facts of an activity batch (the hub keeps a ring per run).
        const n = e.n;
        if (!isHubId(e.run) || typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > HUB_LIMITS.agentBatchEvents)
            return null;
        return { v: HUB_PROTOCOL, id: e.id, from: e.from, to: e.to, kind, ttl: ttlFor(kind, e.ttl), iv: e.iv, ct: e.ct, run: e.run, n };
    }
    // The waiting count of an approvals snapshot (anything else, or a bad value, is dropped, never refused).
    const w = e.waiting;
    const waiting = kind === "approvals" && typeof w === "number" && Number.isInteger(w) && w >= 0 && w <= 999 ? w : undefined;
    const note = kind === "approvals" ? parseAskNoteEnvelope(e.note, e.from, e.to) : undefined;
    return { v: HUB_PROTOCOL, id: e.id, from: e.from, to: e.to, kind, ttl: ttlFor(kind, e.ttl), iv: e.iv, ct: e.ct, ...(waiting !== undefined ? { waiting } : {}), ...(note ? { note } : {}) };
}
/**
 * Checks the `ask_note` an `approvals` envelope carries: an `ask_note` between the same two devices, small, and with
 * nothing nested. A bad one is dropped (the snapshot still goes; the phone then gets the count-only notification).
 *
 * @param x - Untrusted input.
 * @param from - The outer envelope's sender.
 * @param to - The outer envelope's recipient.
 * @returns The note, or undefined.
 */
export function parseAskNoteEnvelope(x, from, to) {
    if (!x || typeof x !== "object")
        return undefined;
    const n = x;
    if (n.kind !== "ask_note" || n.from !== from || n.to !== to || typeof n.ct !== "string" || n.ct.length > HUB_LIMITS.noteCtChars)
        return undefined;
    const env = parseEnvelope({ ...n, note: undefined });
    return env && env.kind === "ask_note" ? env : undefined;
}
/**
 * Reads one device frame from a socket message.
 *
 * @param raw - The text received.
 * @returns The frame, or null when it is not valid JSON of a known shape.
 */
export function parseDeviceFrame(raw) {
    if (typeof raw !== "string" || raw.length > HUB_LIMITS.frameChars)
        return null;
    let x;
    try {
        x = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!x || typeof x !== "object")
        return null;
    switch (x.t) {
        case "hello": {
            const optIn = cleanOptIn(x.optIn);
            const direct = cleanTailscaleDirect(x.direct);
            return { t: "hello", version: str(x.version, 40), ...(typeof x.platform === "string" ? { platform: str(x.platform, 40) } : {}), busy: x.busy === true, optIn, agents: cleanAgents(x.agents, optIn.reportLinks), ...(direct ? { direct } : {}) };
        }
        case "beat": {
            const optIn = x.optIn === undefined ? undefined : cleanOptIn(x.optIn);
            return { t: "beat", busy: x.busy === true, ...(optIn ? { optIn } : {}), agents: cleanAgents(x.agents, optIn?.reportLinks ?? true) };
        }
        case "away":
            return x.state === "asleep" || x.state === "awake" ? { t: "away", state: x.state, note: cleanAwayNote(x.note) } : null;
        case "send": {
            const env = parseEnvelope(x.env);
            return env ? { t: "send", env } : null;
        }
        case "agents": {
            if (!Array.isArray(x.envs) || !x.envs.length || x.envs.length > HUB_LIMITS.agentFrameEnvs)
                return null;
            const envs = x.envs.map(parseEnvelope);
            return envs.every((e) => !!e && e.kind === "agent_event") ? { t: "agents", envs } : null;
        }
        case "ack":
            return isHubId(x.id) ? { t: "ack", id: x.id } : null;
        case "ping":
            return { t: "ping" };
        case "sync":
            return { t: "sync" };
        default:
            return null;
    }
}
/**
 * Checks the plain content after opening an envelope: the right type for its kind, every field present and capped.
 *
 * @param x - The decrypted JSON.
 * @param kind - The envelope's kind (authenticated).
 * @returns The body, or null when it does not match.
 */
export function parseSealedBody(x, kind) {
    if (!x || typeof x !== "object")
        return null;
    const b = x;
    if (b.type !== BODY_FOR_KIND[kind])
        return null;
    const optLink = (v) => (isSafeLink(v) ? { link: v } : {});
    switch (b.type) {
        case "task": {
            if (!isHubId(b.taskId))
                return null;
            const title = str(b.title, HUB_LIMITS.titleChars).trim();
            const spec = str(b.spec, HUB_LIMITS.specChars);
            if (!title)
                return null;
            const executor = EXECUTORS.includes(b.executor) ? b.executor : "auto";
            return { type: "task", taskId: b.taskId, title, spec, executor, ifOffline: b.ifOffline === "cloud" ? "cloud" : "wait", createdAt: str(b.createdAt, 40) };
        }
        case "progress":
            return isHubId(b.taskId) ? { type: "progress", taskId: b.taskId, line: str(b.line, 300) } : null;
        case "result": {
            if (!isHubId(b.taskId))
                return null;
            const status = b.status === "done" || b.status === "failed" || b.status === "blocked" || b.status === "cancelled" ? b.status : null;
            if (!status)
                return null;
            const branch = str(b.branch, 200);
            return { type: "result", taskId: b.taskId, status, text: str(b.text, HUB_LIMITS.resultChars), ...(branch ? { branch } : {}), ...optLink(b.link) };
        }
        case "cancel":
            return isHubId(b.taskId) ? { type: "cancel", taskId: b.taskId } : null;
        case "approval_request":
            if (!isHubId(b.requestId) || !isHubId(b.conversationId))
                return null;
            return { type: "approval_request", requestId: b.requestId, conversationId: b.conversationId, title: str(b.title, HUB_LIMITS.titleChars), tool: str(b.tool, 80), preview: str(b.preview, 2000), reason: str(b.reason, 500) };
        case "approval_answer": {
            if (!isHubId(b.requestId) || !isHubId(b.conversationId))
                return null;
            // "clear" is only for the "Next in line" ask of the task queue; elsewhere it counts as "deny".
            const decision = b.decision === "allow" ? "allow" : b.decision === "clear" ? "clear" : "deny";
            const mins = decision === "allow" && typeof b.forMinutes === "number" && Number.isFinite(b.forMinutes) ? Math.floor(b.forMinutes) : 0;
            return { type: "approval_answer", requestId: b.requestId, conversationId: b.conversationId, decision, ...(mins > 0 ? { forMinutes: Math.min(mins, HUB_LIMITS.approvalForMaxMin) } : {}) };
        }
        case "command":
            if (!isHubId(b.commandId) || !isHubId(b.taskId) || !HUB_COMMAND_ACTIONS.includes(b.action))
                return null;
            if (b.action === "inbox-asknext")
                return b.taskId === "antigravity" || b.taskId === "local" ? { type: "command", commandId: b.commandId, action: b.action, taskId: b.taskId, on: b.on === true } : null;
            if (b.action === "board") {
                const board = cleanBoardCommand(b.board);
                return board ? { type: "command", commandId: b.commandId, action: b.action, taskId: b.taskId, board } : null;
            }
            if (b.action === "assign") {
                const to = parseAssignTo(b.to);
                const model = to === "antigravity" && typeof b.model === "string" && /^[\w .:/()-]{0,80}$/.test(b.model) ? b.model : undefined;
                return to ? { type: "command", commandId: b.commandId, action: b.action, taskId: b.taskId, to, ...(b.confirm === true ? { confirm: true } : {}), ...(model !== undefined ? { model } : {}) } : null;
            }
            if (b.action === "agent-label")
                return { type: "command", commandId: b.commandId, action: b.action, taskId: b.taskId, label: cleanAgentLabel(b.label) };
            return { type: "command", commandId: b.commandId, action: b.action, taskId: b.taskId };
        case "command_result":
            if (!isHubId(b.commandId) || !isHubId(b.taskId))
                return null;
            return { type: "command_result", commandId: b.commandId, taskId: b.taskId, ok: b.ok === true, text: str(b.text, 300), ...(b.ask === "running" || b.ask === "finished" ? { ask: b.ask } : {}) };
        case "approvals":
            if (!Array.isArray(b.items))
                return null;
            return { type: "approvals", items: b.items.slice(0, HUB_LIMITS.approvalItems).map(cleanApproval).filter((a) => !!a), at: num(b.at) };
        case "board": {
            if (!Array.isArray(b.items))
                return null;
            const items = b.items.slice(0, HUB_LIMITS.boardActive + HUB_LIMITS.boardDone).map(cleanBoardItem).filter((i) => !!i);
            return { type: "board", rev: num(b.rev), items, doneTotal: Math.max(num(b.doneTotal), items.filter((i) => i.status === "done").length), at: num(b.at) };
        }
        case "relays":
            return { type: "relays", keys: cleanRelayKeys(b.keys), at: num(b.at) };
        case "quotas":
            return Array.isArray(b.items) ? { type: "quotas", items: cleanProviderQuotas(b.items), at: num(b.at) } : null;
        case "claude_work":
            return Array.isArray(b.sessions) ? { type: "claude_work", sessions: b.sessions.slice(0, 30).map(cleanClaudeSession).filter((x) => !!x), at: num(b.at) } : null;
        case "connector_query": {
            const q = parseConnectorQuery(b);
            return q ? { type: "connector_query", ...q } : null;
        }
        case "connector_answer": {
            const a = parseConnectorAnswer(b);
            return a ? { type: "connector_answer", ...a } : null;
        }
        case "taskchat": {
            const q = parseTaskChatAsk(b);
            return q ? { type: "taskchat", ...q } : null;
        }
        case "taskchat_answer": {
            const a = parseTaskChatAnswer(b);
            return a ? { type: "taskchat_answer", ...a } : null;
        }
        case "cloud_started": {
            if (!isHubId(b.taskId))
                return null;
            const error = str(b.error, 300);
            return { type: "cloud_started", taskId: b.taskId, ...(isSafeLink(b.sessionUrl) ? { sessionUrl: b.sessionUrl } : {}), ...(error ? { error } : {}) };
        }
        case "agent_event": {
            if (!isHubId(b.runId))
                return null;
            const state = parseAgentState(b.state, b.runId);
            if (!state || !Array.isArray(b.events))
                return null;
            const events = b.events.slice(0, HUB_LIMITS.agentBatchEvents).map(parseActivityEvent).filter((e) => !!e);
            return { type: "agent_event", runId: b.runId, state, events };
        }
        case "inbox_task": {
            if (!isHubId(b.taskId))
                return null;
            const title = str(b.title, HUB_LIMITS.titleChars).trim();
            const state = INBOX_STATES.includes(b.state) ? b.state : null;
            if (!title || !state)
                return null;
            // An unknown executor from a newer PC is kept as written (a short word); only a missing or odd one is "claude".
            const executor = typeof b.executor === "string" && /^[a-z][a-z-]{0,23}$/.test(b.executor) ? b.executor : "claude";
            const from = b.from === "roee" || b.from === "self-work" ? b.from : "claude";
            return { type: "inbox_task", taskId: b.taskId, title, state, executor, from, ...optStr("branch", b.branch, 200), ...optStr("result", b.result, 300), ...optNum("estSteps", b.estSteps), ...optNum("steps", b.steps), ...stepNoteOf(b.now), ...agQuotaOf(b.agQuota), ...(state === "deferred" ? optNum("retryAt", b.retryAt) : {}), ...(isHubId(b.runId) ? { runId: b.runId } : {}), ...optStr("model", b.model, HUB_LIMITS.nameChars), ...(isHubId(b.boardId) ? { boardId: b.boardId } : {}), ...optNum("priority", b.priority), ...optNum("queuePos", b.queuePos), ...optNum("lineAt", b.lineAt), ...(typeof b.askNext === "boolean" ? { askNext: b.askNext } : {}), ...(Array.isArray(b.models) ? { models: b.models.filter((m) => typeof m === "string" && m.length > 0).slice(0, 12).map((m) => m.slice(0, HUB_LIMITS.nameChars)) } : {}), ...(b.standing === true ? { standing: true } : {}), ...(HUB_WORK_KINDS.includes(b.kind) ? { kind: b.kind } : {}), ...optNum("startedAt", b.startedAt), ...optNum("endedAt", b.endedAt), ...optStr("cause", oneLine(b.cause), 160), at: num(b.at) };
        }
        case "ask_note": {
            const a = b.ask && typeof b.ask === "object" ? b.ask : undefined;
            if (!a || !isHubId(a.requestId) || !isHubId(a.conversationId))
                return null;
            const until = num(a.until);
            if (!until)
                return null;
            return { type: "ask_note", ask: { requestId: a.requestId, conversationId: a.conversationId, kind: a.kind === "run" ? "run" : "tool", title: str(a.title, HUB_LIMITS.noteTitleChars).trim(), until }, waiting: Math.min(num(b.waiting), 999) };
        }
        default:
            return null;
    }
}
/**
 * Checks a board command (after opening it, before applying it).
 *
 * @param x - Untrusted input.
 * @returns The command, or null.
 */
export function cleanBoardCommand(x) {
    if (!x || typeof x !== "object")
        return null;
    const c = x;
    if (c.op === "reopen" || c.op === "raise")
        return { op: c.op };
    if (c.op === "for-kesher")
        return { op: "for-kesher", on: c.on !== false };
    if (c.op === "note") {
        const text = str(c.text, HUB_LIMITS.boardNoteChars).trim();
        return text ? { op: "note", text } : null;
    }
    return null;
}
/**
 * Checks one board item of a snapshot.
 *
 * @param x - Untrusted input.
 * @returns The item, or null.
 */
export function cleanBoardItem(x) {
    if (!x || typeof x !== "object")
        return null;
    const i = x;
    const status = i.status === "open" || i.status === "claimed" || i.status === "blocked" || i.status === "done" ? i.status : null;
    const title = str(i.title, HUB_LIMITS.titleChars).trim();
    if (!isHubId(i.id) || !status || !title)
        return null;
    const result = str(i.result, 300).trim();
    return {
        id: i.id,
        title,
        status,
        ...(i.owner === "claude" || i.owner === "kesher" || i.owner === "roee" ? { owner: i.owner } : {}),
        size: i.size === "small" ? "small" : "big",
        ...(i.fable === true ? { fable: true } : {}),
        priority: Math.min(num(i.priority) || 5, 99),
        ...(i.forKesher === true ? { forKesher: true } : {}),
        ...(result ? { result } : {}),
        at: num(i.at),
    };
}
/**
 * Fits a PC's board into one sealed snapshot: the active items (taken first, then blocked, then open by priority; at
 * most {@link HUB_LIMITS.boardActive}) and the newest {@link HUB_LIMITS.boardDone} done ones, fields capped, and
 * results then titles shortened (and the oldest done items dropped) until the whole is at most
 * {@link HUB_LIMITS.boardChars} characters.
 *
 * @param all - Every task of the board, as {@link HubBoardItem}s.
 * @returns The items to send, and how many done items the board holds in all.
 */
export function fitBoard(all) {
    const clean = all.map(cleanBoardItem).filter((i) => !!i);
    const rank = { claimed: 0, blocked: 1, open: 2, done: 3 };
    const active = clean.filter((i) => i.status !== "done").sort((a, b) => rank[a.status] - rank[b.status] || a.priority - b.priority || a.at - b.at).slice(0, HUB_LIMITS.boardActive);
    const doneAll = clean.filter((i) => i.status === "done").sort((a, b) => b.at - a.at);
    const done = doneAll.slice(0, HUB_LIMITS.boardDone);
    const size = (items) => JSON.stringify(items).length;
    const cut = (title, result) => (i) => {
        const { result: r, ...rest } = i;
        return { ...rest, title: i.title.slice(0, title), ...(result && r ? { result: r.slice(0, result) } : {}) };
    };
    for (const [title, result] of [[200, 300], [120, 120], [80, 0]]) {
        const items = [...active.map(cut(title, result)), ...done.map(cut(title, result))];
        if (size(items) <= HUB_LIMITS.boardChars)
            return { items, doneTotal: doneAll.length };
    }
    // Still too big: the oldest done items go first.
    const short = active.map(cut(80, 0));
    const shortDone = done.map(cut(80, 0));
    while (shortDone.length && size([...short, ...shortDone]) > HUB_LIMITS.boardChars)
        shortDone.pop();
    return { items: [...short, ...shortDone], doneTotal: doneAll.length };
}
/**
 * Who an item is for: whoever took it, else KesherAI's self-work for a small or handed-over task, else Claude.
 *
 * @param i - The item.
 * @returns The worker.
 */
export function boardWho(i) {
    return i.owner ?? (!i.fable && (i.forKesher || i.size === "small") ? "kesher" : "claude");
}
/**
 * Whether an item waits on Roee: blocked, or taken by him and not done.
 *
 * @param i - The item.
 * @returns True when it needs him.
 */
export function boardWaitsOnMe(i) {
    return i.status === "blocked" || (i.status !== "done" && i.owner === "roee");
}
/**
 * The page's filters over a snapshot: Open (not done), Waiting on me, Done; and optionally one owner chip.
 *
 * @param items - The snapshot's items.
 * @param filter - The status filter.
 * @param who - An owner chip, or none for all.
 * @returns The matching items.
 */
export function boardView(items, filter, who) {
    return items.filter((i) => (filter === "done" ? i.status === "done" : filter === "me" ? boardWaitsOnMe(i) : i.status !== "done") && (!who || boardWho(i) === who));
}
const INBOX_STATES = ["waiting", "waiting-run", "running", "done", "failed", "partial", "deferred"];
const SOURCES = ["chat-helper", "inbox", "antigravity", "claude-cloud", "claude-chat"];
const RUN_STATES = ["queued", "running", "waiting", "done", "failed", "cancelled"];
const FILE_OPS = ["read", "edit", "create", "delete"];
/** A commit of a session, cleaned; null when it is not one. */
function cleanClaudeCommit(x) {
    if (!x || typeof x !== "object")
        return null;
    const c = x;
    const title = oneLine(c.title);
    if (typeof c.sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(c.sha) || !title)
        return null;
    const release = typeof c.release === "string" && /^\d+\.\d+\.\d+$/.test(c.release) ? c.release : undefined;
    const url = typeof c.url === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/commit\/[0-9a-f]{7,64}$/i.test(c.url) ? c.url : undefined;
    return { sha: c.sha, title: title.slice(0, 200), files: num(c.files), at: num(c.at), ...(release ? { release } : {}), ...(url ? { url } : {}) };
}
/** A session, cleaned (at most 20 commits); null when it has no commit. */
function cleanClaudeSession(x) {
    if (!x || typeof x !== "object")
        return null;
    const s = x;
    const commits = Array.isArray(s.commits) ? s.commits.slice(0, 20).map(cleanClaudeCommit).filter((c) => !!c) : [];
    const title = oneLine(s.title);
    if (!commits.length || !title || typeof s.id !== "string")
        return null;
    return { id: s.id.slice(0, 80), title: title.slice(0, 200), at: num(s.at), commits };
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const optNum = (k, v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? { [k]: Math.floor(v) } : {});
/** A string on one line (whitespace runs become one space), or undefined for anything else. */
const oneLine = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : undefined);
/** A running task's current step (task-steps.ts StepNote), checked: short one-line strings, numbers only. */
function stepNoteOf(v) {
    if (!v || typeof v !== "object")
        return {};
    const o = v;
    const tool = oneLine(o.tool)?.slice(0, 60);
    if (!tool)
        return {};
    const target = oneLine(o.target)?.slice(0, 200);
    return { now: { tool, ...(target ? { target } : {}), at: num(o.at), ...(o.error === true ? { error: true } : {}) } };
}
/** Antigravity's quota as the PC reported it: a share 0..1 and an optional reset time. */
function agQuotaOf(v) {
    if (!v || typeof v !== "object")
        return {};
    const o = v;
    if (typeof o.left !== "number" || !Number.isFinite(o.left))
        return {};
    return { agQuota: { left: Math.max(0, Math.min(1, o.left)), ...optNum("resetAt", o.resetAt) } };
}
const optStr = (k, v, max) => (typeof v === "string" && v ? { [k]: v.slice(0, max) } : {});
/**
 * A file path as an event may carry it: relative, forward slashes, no `..`, no drive or home prefix, at most 160
 * characters. A path that cannot be made safe is dropped.
 *
 * @param p - The path as the agent named it.
 * @returns The clean path, or undefined.
 */
export function cleanAgentPath(p) {
    if (typeof p !== "string")
        return undefined;
    let s = p.trim().replace(/\\/g, "/");
    // An absolute path keeps only its last three parts (never a user name or a home folder).
    if (/^([a-zA-Z]:)?\//.test(s) || s.startsWith("~"))
        s = s.split("/").filter((x) => x && x !== "~").slice(-3).join("/");
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
    if (!s || s.split("/").includes("..") || /[\u0000-\u001f]/.test(s))
        return undefined;
    return s.slice(-160);
}
function parseWaiting(x) {
    if (!x || typeof x !== "object")
        return undefined;
    const w = x;
    if (!isHubId(w.requestId) || !isHubId(w.conversationId))
        return undefined;
    const reason = w.reason === "ask" || w.reason === "run-press" ? w.reason : "approval";
    return { reason, requestId: w.requestId, conversationId: w.conversationId, summary: str(w.summary, 200) };
}
/**
 * Checks one activity event (after opening a batch): a known type, its fields present and capped.
 *
 * @param x - Untrusted input.
 * @returns The event, or null.
 */
export function parseActivityEvent(x) {
    if (!x || typeof x !== "object")
        return null;
    const e = x;
    const head = { seq: num(e.seq), t: num(e.t) };
    switch (e.type) {
        case "started": {
            const title = str(e.title, 120).trim();
            if (!title || !SOURCES.includes(e.source))
                return null;
            return { ...head, type: "started", title, source: e.source, ...optStr("model", e.model, HUB_LIMITS.nameChars) };
        }
        case "step":
            return { ...head, type: "step", n: num(e.n), ...optNum("of", e.of), label: str(e.label, 80) };
        case "tool": {
            const name = str(e.name, 60);
            return name ? { ...head, type: "tool", name, ok: e.ok !== false, ...optNum("ms", e.ms) } : null;
        }
        case "file": {
            const path = cleanAgentPath(e.path);
            return path ? { ...head, type: "file", path, op: FILE_OPS.includes(e.op) ? e.op : "read" } : null;
        }
        case "usage":
            return { ...head, type: "usage", tokensIn: num(e.tokensIn), tokensOut: num(e.tokensOut) };
        case "waiting": {
            const w = parseWaiting(e);
            return w ? { ...head, type: "waiting", ...w } : null;
        }
        case "done": {
            const branch = str(e.branch, 200);
            return { ...head, type: "done", steps: num(e.steps), ...(branch ? { branch } : {}), ...(isSafeLink(e.link) ? { link: e.link } : {}), ...optStr("summary", e.summary, 300) };
        }
        case "failed":
            return { ...head, type: "failed", reason: str(e.reason, 200) };
        case "cancelled":
            return { ...head, type: "cancelled" };
        default:
            return null;
    }
}
/**
 * Checks a run's state (after opening a batch).
 *
 * @param x - Untrusted input.
 * @param runId - The batch's run id (the state must be for the same run).
 * @returns The state, or null.
 */
export function parseAgentState(x, runId) {
    if (!x || typeof x !== "object")
        return null;
    const s = x;
    if (s.runId !== runId || !SOURCES.includes(s.source) || !RUN_STATES.includes(s.state))
        return null;
    const names = Array.isArray(s.fileNames) ? s.fileNames.map(cleanAgentPath).filter((p) => !!p).slice(-5) : [];
    const waiting = s.state === "waiting" ? parseWaiting(s.waiting) : undefined;
    const branch = str(s.branch, 200);
    return {
        runId,
        title: str(s.title, 120).trim() || "Agent",
        source: s.source,
        state: s.state,
        ...optStr("model", s.model, HUB_LIMITS.nameChars),
        step: num(s.step),
        ...optNum("of", s.of),
        ...optStr("label", s.label, 80),
        startedAt: num(s.startedAt),
        lastEventAt: num(s.lastEventAt),
        ...optNum("endedAt", s.endedAt),
        ...optNum("tokensIn", s.tokensIn),
        ...optNum("tokensOut", s.tokensOut),
        files: num(s.files),
        fileNames: names,
        ...(waiting ? { waiting } : {}),
        ...(branch ? { branch } : {}),
        ...(isSafeLink(s.link) ? { link: s.link } : {}),
        ...optStr("summary", s.summary, 300),
        ...labelOf(s),
    };
}
/** The owner's label carried in a run's state, cleaned (agent-label.ts). */
function labelOf(s) {
    const l = cleanAgentLabel(s, typeof s.labelAt === "number" ? s.labelAt : undefined);
    return { ...(l.name ? { name: l.name } : {}), ...(l.note ? { note: l.note } : {}), ...(l.at ? { labelAt: l.at } : {}) };
}
/**
 * Holds `sync` pings to one per {@link HUB_LIMITS.syncPingMs}: the first goes at once, the ones asked for within the
 * gap become a single ping at its end (so the last write is always announced, and the hub never drops it).
 *
 * @param send - Sends the frame (the device's socket).
 * @param o - The gap and the clock (tests pass their own).
 * @returns The pinger.
 */
export function syncPinger(send, o = {}) {
    const gap = o.gapMs ?? HUB_LIMITS.syncPingMs;
    const now = o.now ?? Date.now;
    const setTimer = o.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t));
    let last = -Infinity;
    let held;
    const fire = () => {
        held = undefined;
        last = now();
        send();
    };
    return {
        ping() {
            if (held !== undefined)
                return;
            const wait = last + gap - now();
            if (wait <= 0)
                return fire();
            held = setTimer(fire, wait);
            held.unref?.();
        },
        cancel() {
            if (held !== undefined)
                clearTimer(held);
            held = undefined;
        },
    };
}
