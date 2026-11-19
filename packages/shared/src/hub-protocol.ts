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
export const HUB_PROTOCOL = 1 as const;

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
} as const;

/** What a paired device is. */
export type HubDeviceKind = "pc" | "phone";

/** What a sealed envelope carries (the hub routes by this; the content stays sealed). */
export type SealedKind = "task" | "progress" | "result" | "cancel" | "approval_request" | "approval_answer" | "cloud" | "cloud_started";

const SEALED_KINDS: readonly SealedKind[] = ["task", "progress", "result", "cancel", "approval_request", "approval_answer", "cloud", "cloud_started"];

/** A message the hub relays without reading: `ct` is AES-GCM under a key only the two devices can derive. */
export interface SealedEnvelope {
  v: typeof HUB_PROTOCOL;
  /** Unique message id (also the HKDF salt and part of the authenticated data). */
  id: string;
  /** Sender device id ("hub" for the hub's own replies). */
  from: string;
  /** Recipient device id, or "hub" for the Claude cloud path. */
  to: string;
  kind: SealedKind;
  /** Seconds the hub may keep it queued for an offline recipient. */
  ttl: number;
  /** AES-GCM nonce, base64url. */
  iv: string;
  /** Ciphertext with its tag, base64url. */
  ct: string;
}

/**
 * Which work a PC takes from the hub (per-device opt-in, like Bionic's "each machine decides"). Defaults: it appears
 * in the hub, but accepts no tasks until Roee turns that on.
 */
export interface HubOptIn {
  /** Shown in the hub's device list (off: the PC stays connected only for its own results). */
  appear: boolean;
  /** Accepts tasks at all. */
  acceptTasks: boolean;
  /** Accepts tasks for its local model. */
  acceptLocal: boolean;
  /** Accepts Antigravity tasks (they still wait for Run by hand). */
  acceptAntigravity: boolean;
  /** Reports vendor session links (e.g. a Claude Remote Control URL) as presence metadata. */
  reportLinks: boolean;
}

/** The opt-in a new PC starts with. */
export const DEFAULT_OPT_IN: HubOptIn = { appear: true, acceptTasks: false, acceptLocal: false, acceptAntigravity: false, reportLinks: false };

/** An agent a device reports (a loaded local model, Antigravity, a vendor session such as Claude Remote Control). */
export interface HubAgent {
  /** e.g. "local-model", "antigravity", "claude-remote-control", "codex". */
  kind: string;
  state: "on" | "off" | "busy";
  /** Short label ("Qwen 3 8B"). */
  label?: string;
  /** A vendor session link (https only), shown as "Open in the app"; only when the PC's opt-in allows it. */
  link?: string;
}

/** One device as the hub shows it to the others (metadata only). */
export interface HubPresence {
  id: string;
  name: string;
  kind: HubDeviceKind;
  /** The device's ECDH P-256 public key (raw, base64url), to seal messages to it. */
  publicKey: string;
  online: boolean;
  /** ISO time it was last heard from. */
  lastSeen?: string;
  busy: boolean;
  optIn: HubOptIn;
  agents: HubAgent[];
  version?: string;
}

/** A frame a device sends the hub over its socket. */
export type DeviceFrame =
  | { t: "hello"; version: string; platform?: string; busy: boolean; optIn: HubOptIn; agents: HubAgent[] }
  | { t: "beat"; busy: boolean; optIn?: HubOptIn; agents: HubAgent[] }
  | { t: "send"; env: SealedEnvelope }
  | { t: "ack"; id: string };

/** Why the hub refused a frame. */
export type HubRefusal = "bad-frame" | "rate-limited" | "paused" | "no-recipient" | "not-accepting" | "too-big" | "cloud-off" | "cloud-failed" | "not-allowed";

/** A frame the hub sends a device. */
export type HubFrame =
  | { t: "welcome"; deviceId: string; hubKey: string; presence: HubPresence[]; paused: boolean; rotateDue: boolean }
  | { t: "presence"; presence: HubPresence[] }
  | { t: "deliver"; env: SealedEnvelope }
  | { t: "sent"; id: string; queued: boolean }
  | { t: "refused"; id?: string; code: HubRefusal }
  | { t: "pause"; paused: boolean }
  | { t: "revoked" };

/** Who runs a task. */
export type HubExecutor = "auto" | "claude-cloud" | "pc-local" | "pc-antigravity" | "pc-any";

const EXECUTORS: readonly HubExecutor[] = ["auto", "claude-cloud", "pc-local", "pc-antigravity", "pc-any"];

/** What to do when the task needs a PC and none is on. */
export type HubIfOffline = "wait" | "cloud";

/** The plain content inside a sealed envelope. */
export type SealedBody =
  | { type: "task"; taskId: string; title: string; spec: string; executor: HubExecutor; ifOffline: HubIfOffline; createdAt: string }
  | { type: "progress"; taskId: string; line: string }
  | { type: "result"; taskId: string; status: "done" | "failed" | "blocked" | "cancelled"; text: string; branch?: string; link?: string }
  | { type: "cancel"; taskId: string }
  | { type: "approval_request"; requestId: string; conversationId: string; title: string; tool: string; preview: string; reason: string }
  | { type: "approval_answer"; requestId: string; conversationId: string; decision: "allow" | "deny" }
  | { type: "cloud_started"; taskId: string; sessionUrl?: string; error?: string };

/** Which body type each envelope kind must hold (checked after opening, so a kind cannot be swapped). */
export const BODY_FOR_KIND: Record<SealedKind, SealedBody["type"]> = {
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
export function isHubId(s: unknown): s is string {
  return typeof s === "string" && ID.test(s);
}

/**
 * Whether a link may be shown as a button: https only, no credentials in it, at most {@link HUB_LIMITS.linkChars}.
 *
 * @param s - The link.
 * @returns True when it is safe to show.
 */
export function isSafeLink(s: unknown): s is string {
  if (typeof s !== "string" || s.length > HUB_LIMITS.linkChars) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v : "").slice(0, max);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);

/**
 * A clean opt-in from untrusted input (missing fields take the defaults).
 *
 * @param x - What the device sent.
 * @returns The opt-in.
 */
export function cleanOptIn(x: unknown): HubOptIn {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
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
export function cleanAgents(x: unknown, reportLinks: boolean): HubAgent[] {
  if (!Array.isArray(x)) return [];
  const out: HubAgent[] = [];
  for (const a of x.slice(0, HUB_LIMITS.agents)) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    const kind = str(r.kind, 40);
    if (!/^[a-z0-9-]{1,40}$/.test(kind)) continue;
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
export function ttlFor(kind: SealedKind, asked: unknown): number {
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
export function parseEnvelope(x: unknown): SealedEnvelope | null {
  if (!x || typeof x !== "object") return null;
  const e = x as Record<string, unknown>;
  if (e.v !== HUB_PROTOCOL || !isHubId(e.id) || !isHubId(e.from) || !isHubId(e.to)) return null;
  if (typeof e.kind !== "string" || !SEALED_KINDS.includes(e.kind as SealedKind)) return null;
  if (typeof e.iv !== "string" || e.iv.length !== 16 || !B64URL.test(e.iv)) return null;
  if (typeof e.ct !== "string" || !e.ct || e.ct.length > HUB_LIMITS.ctChars || !B64URL.test(e.ct)) return null;
  const kind = e.kind as SealedKind;
  return { v: HUB_PROTOCOL, id: e.id, from: e.from, to: e.to, kind, ttl: ttlFor(kind, e.ttl), iv: e.iv, ct: e.ct };
}

/**
 * Reads one device frame from a socket message.
 *
 * @param raw - The text received.
 * @returns The frame, or null when it is not valid JSON of a known shape.
 */
export function parseDeviceFrame(raw: unknown): DeviceFrame | null {
  if (typeof raw !== "string" || raw.length > HUB_LIMITS.frameChars) return null;
  let x: Record<string, unknown>;
  try {
    x = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!x || typeof x !== "object") return null;
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
export function parseSealedBody(x: unknown, kind: SealedKind): SealedBody | null {
  if (!x || typeof x !== "object") return null;
  const b = x as Record<string, unknown>;
  if (b.type !== BODY_FOR_KIND[kind]) return null;
  const optLink = (v: unknown) => (isSafeLink(v) ? { link: v } : {});
  switch (b.type) {
    case "task": {
      if (!isHubId(b.taskId)) return null;
      const title = str(b.title, HUB_LIMITS.titleChars).trim();
      const spec = str(b.spec, HUB_LIMITS.specChars);
      if (!title) return null;
      const executor = EXECUTORS.includes(b.executor as HubExecutor) ? (b.executor as HubExecutor) : "auto";
      return { type: "task", taskId: b.taskId, title, spec, executor, ifOffline: b.ifOffline === "cloud" ? "cloud" : "wait", createdAt: str(b.createdAt, 40) };
    }
    case "progress":
      return isHubId(b.taskId) ? { type: "progress", taskId: b.taskId, line: str(b.line, 300) } : null;
    case "result": {
      if (!isHubId(b.taskId)) return null;
      const status = b.status === "done" || b.status === "failed" || b.status === "blocked" || b.status === "cancelled" ? b.status : null;
      if (!status) return null;
      const branch = str(b.branch, 200);
      return { type: "result", taskId: b.taskId, status, text: str(b.text, HUB_LIMITS.resultChars), ...(branch ? { branch } : {}), ...optLink(b.link) };
    }
    case "cancel":
      return isHubId(b.taskId) ? { type: "cancel", taskId: b.taskId } : null;
    case "approval_request":
      if (!isHubId(b.requestId) || !isHubId(b.conversationId)) return null;
      return { type: "approval_request", requestId: b.requestId, conversationId: b.conversationId, title: str(b.title, HUB_LIMITS.titleChars), tool: str(b.tool, 80), preview: str(b.preview, 2000), reason: str(b.reason, 500) };
    case "approval_answer":
      if (!isHubId(b.requestId) || !isHubId(b.conversationId)) return null;
      return { type: "approval_answer", requestId: b.requestId, conversationId: b.conversationId, decision: b.decision === "allow" ? "allow" : "deny" };
    case "cloud_started": {
      if (!isHubId(b.taskId)) return null;
      const error = str(b.error, 300);
      return { type: "cloud_started", taskId: b.taskId, ...(isSafeLink(b.sessionUrl) ? { sessionUrl: b.sessionUrl } : {}), ...(error ? { error } : {}) };
    }
    default:
      return null;
  }
}
