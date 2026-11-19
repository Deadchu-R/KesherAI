/**
 * Kesher Cloud hub: the wire protocol between the hub (a Cloudflare Worker) and the paired devices (PCs, the phone).
 * The hub is a thin relay (docs/RESEARCH_LOG.md, "Kesher Cloud hub" and its addendum): it sees presence and routing
 * metadata only; every task, result and approval travels as a {@link SealedEnvelope} the hub cannot read. The one
 * exception is a message sealed to the hub itself (`to: "hub"`, kind `cloud`) for the Claude cloud path.
 *
 * Everything here is plain data and small validators, with no Node or browser API, so the Worker, the PC (core) and
 * the phone page share one copy.
 */
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
};
const SEALED_KINDS = ["task", "progress", "result", "cancel", "approval_request", "approval_answer", "cloud", "cloud_started"];
/** The opt-in a new PC starts with. */
export const DEFAULT_OPT_IN = { appear: true, acceptTasks: false, acceptLocal: false, acceptAntigravity: false, reportLinks: false };
const EXECUTORS = ["auto", "claude-cloud", "pc-local", "pc-antigravity", "pc-any"];
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
    const max = kind === "approval_request" || kind === "approval_answer" ? HUB_LIMITS.approvalTtl : HUB_LIMITS.maxTtl;
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
    return { v: HUB_PROTOCOL, id: e.id, from: e.from, to: e.to, kind, ttl: ttlFor(kind, e.ttl), iv: e.iv, ct: e.ct };
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
        case "ack":
            return isHubId(x.id) ? { t: "ack", id: x.id } : null;
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
        case "approval_answer":
            if (!isHubId(b.requestId) || !isHubId(b.conversationId))
                return null;
            return { type: "approval_answer", requestId: b.requestId, conversationId: b.conversationId, decision: b.decision === "allow" ? "allow" : "deny" };
        case "cloud_started": {
            if (!isHubId(b.taskId))
                return null;
            const error = str(b.error, 300);
            return { type: "cloud_started", taskId: b.taskId, ...(isSafeLink(b.sessionUrl) ? { sessionUrl: b.sessionUrl } : {}), ...(error ? { error } : {}) };
        }
        default:
            return null;
    }
}
