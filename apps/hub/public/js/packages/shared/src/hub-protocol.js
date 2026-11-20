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
    /** The longest "Allow for a while" from the hub page, in minutes (a day, as on the PC's own card). */
    approvalForMaxMin: 24 * 60,
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
const SEALED_KINDS = ["task", "progress", "result", "cancel", "approval_request", "approval_answer", "cloud", "cloud_started", "agent_event", "inbox_task", "approvals", "command", "command_result"];
/** The opt-in a new PC starts with. */
export const DEFAULT_OPT_IN = { appear: true, acceptTasks: false, acceptLocal: false, acceptAntigravity: false, reportLinks: false, reportActivity: false, reportFileNames: false };
const EXECUTORS = ["auto", "claude-cloud", "pc-local", "pc-antigravity", "pc-any"];
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
        title: str(a.title, 120).trim(),
        tool: str(a.tool, 80),
        ...optStr("who", a.who, 80),
        reason: str(a.reason, 300),
        preview: str(a.preview, 600),
        kind,
        forWhile: kind === "tool" && a.forWhile === true,
        at: num(a.at),
    };
}
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
    const max = kind === "approval_request" || kind === "approval_answer" || kind === "approvals" || kind === "command" || kind === "command_result" ? HUB_LIMITS.approvalTtl : HUB_LIMITS.maxTtl;
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
    return { v: HUB_PROTOCOL, id: e.id, from: e.from, to: e.to, kind, ttl: ttlFor(kind, e.ttl), iv: e.iv, ct: e.ct, ...(waiting !== undefined ? { waiting } : {}) };
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
            return { t: "hello", version: str(x.version, 40), ...(typeof x.platform === "string" ? { platform: str(x.platform, 40) } : {}), busy: x.busy === true, optIn, agents: cleanAgents(x.agents, optIn.reportLinks) };
        }
        case "beat": {
            const optIn = x.optIn === undefined ? undefined : cleanOptIn(x.optIn);
            return { t: "beat", busy: x.busy === true, ...(optIn ? { optIn } : {}), agents: cleanAgents(x.agents, optIn?.reportLinks ?? true) };
        }
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
            const decision = b.decision === "allow" ? "allow" : "deny";
            const mins = decision === "allow" && typeof b.forMinutes === "number" && Number.isFinite(b.forMinutes) ? Math.floor(b.forMinutes) : 0;
            return { type: "approval_answer", requestId: b.requestId, conversationId: b.conversationId, decision, ...(mins > 0 ? { forMinutes: Math.min(mins, HUB_LIMITS.approvalForMaxMin) } : {}) };
        }
        case "command":
            if (!isHubId(b.commandId) || !isHubId(b.taskId) || (b.action !== "inbox-run" && b.action !== "inbox-cancel" && b.action !== "agent-label" && b.action !== "assign"))
                return null;
            if (b.action === "assign") {
                const to = parseAssignTo(b.to);
                return to ? { type: "command", commandId: b.commandId, action: b.action, taskId: b.taskId, to, ...(b.confirm === true ? { confirm: true } : {}) } : null;
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
            const executor = INBOX_EXECUTORS.includes(b.executor) ? b.executor : "claude";
            const from = b.from === "roee" || b.from === "self-work" ? b.from : "claude";
            return { type: "inbox_task", taskId: b.taskId, title, state, executor, from, ...optStr("branch", b.branch, 200), ...optStr("result", b.result, 300), ...(isHubId(b.runId) ? { runId: b.runId } : {}), at: num(b.at) };
        }
        default:
            return null;
    }
}
const INBOX_STATES = ["waiting", "waiting-run", "running", "done", "failed", "partial"];
const INBOX_EXECUTORS = ["local", "antigravity", "claude"];
const SOURCES = ["chat-helper", "inbox", "antigravity", "claude-cloud", "claude-chat"];
const RUN_STATES = ["queued", "running", "waiting", "done", "failed", "cancelled"];
const FILE_OPS = ["read", "edit", "create", "delete"];
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const optNum = (k, v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? { [k]: Math.floor(v) } : {});
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
