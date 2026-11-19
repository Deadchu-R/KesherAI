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
  /** Live agent activity: events in one batch, runs in one `agents` frame, events the hub keeps per run and for how long. */
  agentBatchEvents: 20,
  agentFrameEnvs: 16,
  agentEventsPerRun: 50,
  agentKeepMs: 7 * 24 * 3600 * 1000,
  /** A running agent's heartbeat, and how long without one before a viewer shows it as stale (the Cursor freeze lesson). */
  agentBeatMs: 25_000,
  agentStaleMs: 90_000,
} as const;

/** What a paired device is. */
export type HubDeviceKind = "pc" | "phone";

/** What a sealed envelope carries (the hub routes by this; the content stays sealed). */
export type SealedKind = "task" | "progress" | "result" | "cancel" | "approval_request" | "approval_answer" | "cloud" | "cloud_started" | "agent_event";

const SEALED_KINDS: readonly SealedKind[] = ["task", "progress", "result", "cancel", "approval_request", "approval_answer", "cloud", "cloud_started", "agent_event"];

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
  /** `agent_event` only: the run it belongs to (an opaque id; the hub keeps the last events of each run by it). */
  run?: string;
  /** `agent_event` only: how many events it carries (0 = a heartbeat that only refreshes the run's state). */
  n?: number;
  /** Set by the hub on an `agent_event` it delivers: its order number (for catch-up) and when it arrived (ms). */
  seq?: number;
  at?: number;
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
  /** Sends live agent activity (sealed: titles, steps, tool names, counts) to the owner's phones and hub page. */
  reportActivity: boolean;
  /** With activity: also the names (relative paths) of files the agents touch, never their contents. */
  reportFileNames: boolean;
}

/** The opt-in a new PC starts with. */
export const DEFAULT_OPT_IN: HubOptIn = { appear: true, acceptTasks: false, acceptLocal: false, acceptAntigravity: false, reportLinks: false, reportActivity: false, reportFileNames: false };

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
  /** Live agent activity: one sealed `agent_event` per (viewer, run), kept by the hub as a short ring, never queued. */
  | { t: "agents"; envs: SealedEnvelope[] }
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
  | { type: "cloud_started"; taskId: string; sessionUrl?: string; error?: string }
  /** One run's activity since the last batch, with its whole current state (so the newest batch alone draws the card). */
  | { type: "agent_event"; runId: string; state: AgentRunState; events: ActivityEvent[] };

// ---- live agent activity (docs/RESEARCH_LOG.md, "Live agent activity in the Kesher Cloud hub") ----

/** Where an agent run comes from. */
export type AgentSource = "chat-helper" | "inbox" | "antigravity" | "claude-cloud";

/** A run's state. `stale` is never sent: a viewer shows it when a going run's heartbeat stops for 90 seconds. */
export type AgentRunStateName = "queued" | "running" | "waiting" | "done" | "failed" | "cancelled" | "stale";

/** What a waiting run waits for, and how to answer it (the existing `approval_answer` with these two ids). */
export interface AgentWaiting {
  /** approval: a tool approval; ask: a yes/no question of the run; run-press: Antigravity waits for Run. */
  reason: "approval" | "ask" | "run-press";
  requestId: string;
  conversationId: string;
  /** Short text made by KesherAI (never the prompt or a file's text). */
  summary: string;
}

/** A file an agent touched: its path relative to the project, never its content. */
export interface AgentFile {
  path: string;
  op: "read" | "edit" | "create" | "delete";
}

/**
 * One event of a run. Metadata only (privacy rule of the research entry): titles, step numbers, tool names, relative
 * paths when the PC allows names, token counts. Never a prompt, a file's text, a diff or the model's output.
 */
export type ActivityEvent = { seq: number; t: number } & (
  | { type: "started"; title: string; source: AgentSource; model?: string }
  | { type: "step"; n: number; of?: number; label: string }
  | { type: "tool"; name: string; ok: boolean; ms?: number }
  | ({ type: "file" } & AgentFile)
  | { type: "usage"; tokensIn: number; tokensOut: number }
  | ({ type: "waiting" } & AgentWaiting)
  | { type: "done"; steps: number; branch?: string; link?: string }
  | { type: "failed"; reason: string }
  | { type: "cancelled" }
);

/** A run's whole current state, carried in every batch. */
export interface AgentRunState {
  runId: string;
  title: string;
  source: AgentSource;
  state: Exclude<AgentRunStateName, "stale">;
  model?: string;
  /** Steps done, the most allowed, and the current step's label (a tool name). */
  step: number;
  of?: number;
  label?: string;
  startedAt: number;
  lastEventAt: number;
  endedAt?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** How many files it touched, and the last few names (only when the PC reports file names). */
  files: number;
  fileNames: string[];
  waiting?: AgentWaiting;
  branch?: string;
  link?: string;
}

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
  agent_event: "agent_event",
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
  if (kind === "agent_event") {
    // The run id and the event count are the only plain facts of an activity batch (the hub keeps a ring per run).
    const n = e.n;
    if (!isHubId(e.run) || typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > HUB_LIMITS.agentBatchEvents) return null;
    return { v: HUB_PROTOCOL, id: e.id, from: e.from, to: e.to, kind, ttl: ttlFor(kind, e.ttl), iv: e.iv, ct: e.ct, run: e.run, n };
  }
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
    case "agents": {
      if (!Array.isArray(x.envs) || !x.envs.length || x.envs.length > HUB_LIMITS.agentFrameEnvs) return null;
      const envs = x.envs.map(parseEnvelope);
      return envs.every((e): e is SealedEnvelope => !!e && e.kind === "agent_event") ? { t: "agents", envs } : null;
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
    case "agent_event": {
      if (!isHubId(b.runId)) return null;
      const state = parseAgentState(b.state, b.runId);
      if (!state || !Array.isArray(b.events)) return null;
      const events = b.events.slice(0, HUB_LIMITS.agentBatchEvents).map(parseActivityEvent).filter((e): e is ActivityEvent => !!e);
      return { type: "agent_event", runId: b.runId, state, events };
    }
    default:
      return null;
  }
}

const SOURCES: readonly AgentSource[] = ["chat-helper", "inbox", "antigravity", "claude-cloud"];
const RUN_STATES: readonly AgentRunState["state"][] = ["queued", "running", "waiting", "done", "failed", "cancelled"];
const FILE_OPS: readonly AgentFile["op"][] = ["read", "edit", "create", "delete"];
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const optNum = (k: string, v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? { [k]: Math.floor(v) } : {});
const optStr = (k: string, v: unknown, max: number) => (typeof v === "string" && v ? { [k]: v.slice(0, max) } : {});

/**
 * A file path as an event may carry it: relative, forward slashes, no `..`, no drive or home prefix, at most 160
 * characters. A path that cannot be made safe is dropped.
 *
 * @param p - The path as the agent named it.
 * @returns The clean path, or undefined.
 */
export function cleanAgentPath(p: unknown): string | undefined {
  if (typeof p !== "string") return undefined;
  let s = p.trim().replace(/\\/g, "/");
  // An absolute path keeps only its last three parts (never a user name or a home folder).
  if (/^([a-zA-Z]:)?\//.test(s) || s.startsWith("~")) s = s.split("/").filter((x) => x && x !== "~").slice(-3).join("/");
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
  if (!s || s.split("/").includes("..") || /[\u0000-\u001f]/.test(s)) return undefined;
  return s.slice(-160);
}

function parseWaiting(x: unknown): AgentWaiting | undefined {
  if (!x || typeof x !== "object") return undefined;
  const w = x as Record<string, unknown>;
  if (!isHubId(w.requestId) || !isHubId(w.conversationId)) return undefined;
  const reason = w.reason === "ask" || w.reason === "run-press" ? w.reason : "approval";
  return { reason, requestId: w.requestId, conversationId: w.conversationId, summary: str(w.summary, 200) };
}

/**
 * Checks one activity event (after opening a batch): a known type, its fields present and capped.
 *
 * @param x - Untrusted input.
 * @returns The event, or null.
 */
export function parseActivityEvent(x: unknown): ActivityEvent | null {
  if (!x || typeof x !== "object") return null;
  const e = x as Record<string, unknown>;
  const head = { seq: num(e.seq), t: num(e.t) };
  switch (e.type) {
    case "started": {
      const title = str(e.title, 120).trim();
      if (!title || !SOURCES.includes(e.source as AgentSource)) return null;
      return { ...head, type: "started", title, source: e.source as AgentSource, ...optStr("model", e.model, HUB_LIMITS.nameChars) };
    }
    case "step":
      return { ...head, type: "step", n: num(e.n), ...optNum("of", e.of), label: str(e.label, 80) };
    case "tool": {
      const name = str(e.name, 60);
      return name ? { ...head, type: "tool", name, ok: e.ok !== false, ...optNum("ms", e.ms) } : null;
    }
    case "file": {
      const path = cleanAgentPath(e.path);
      return path ? { ...head, type: "file", path, op: FILE_OPS.includes(e.op as AgentFile["op"]) ? (e.op as AgentFile["op"]) : "read" } : null;
    }
    case "usage":
      return { ...head, type: "usage", tokensIn: num(e.tokensIn), tokensOut: num(e.tokensOut) };
    case "waiting": {
      const w = parseWaiting(e);
      return w ? { ...head, type: "waiting", ...w } : null;
    }
    case "done": {
      const branch = str(e.branch, 200);
      return { ...head, type: "done", steps: num(e.steps), ...(branch ? { branch } : {}), ...(isSafeLink(e.link) ? { link: e.link } : {}) };
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
export function parseAgentState(x: unknown, runId: string): AgentRunState | null {
  if (!x || typeof x !== "object") return null;
  const s = x as Record<string, unknown>;
  if (s.runId !== runId || !SOURCES.includes(s.source as AgentSource) || !RUN_STATES.includes(s.state as AgentRunState["state"])) return null;
  const names = Array.isArray(s.fileNames) ? s.fileNames.map(cleanAgentPath).filter((p): p is string => !!p).slice(-5) : [];
  const waiting = s.state === "waiting" ? parseWaiting(s.waiting) : undefined;
  const branch = str(s.branch, 200);
  return {
    runId,
    title: str(s.title, 120).trim() || "Agent",
    source: s.source as AgentSource,
    state: s.state as AgentRunState["state"],
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
  };
}
