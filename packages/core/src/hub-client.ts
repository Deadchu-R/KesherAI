/**
 * Kesher Cloud hub, the PC side (docs/RESEARCH_LOG.md, "Kesher Cloud hub"). Off by default. When the user turns it on,
 * this PC pairs with the hub (a code approved on the hub page), then keeps one **outward** WebSocket: nothing listens
 * on the PC for the hub. It reports presence (busy, what it accepts, its agents), receives sealed tasks, puts each on
 * the existing task board (so the board and the bell notification are where the user sees them), acknowledges only
 * after that, and sends a short sealed result back when the board item is done or blocked.
 *
 * The hub never makes this PC run anything: a task becomes a board item like any other, under the board's own rules.
 * The device token and this PC's private key live in the encrypted config and are never logged or sent to a page.
 */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import WebSocket from "ws";
import {
  cleanOptIn,
  estimateTaskSteps,
  exportPrivateJwk,
  fitApprovals,
  HUB_LIMITS,
  generateHubKeys,
  importPrivateJwk,
  keyFingerprint,
  openEnvelope,
  ReplayGuard,
  sealMessage,
  syncPinger,
  workKindOf,
  type HubAgent,
  cleanAwayNote,
  cleanAblyKey,
  cleanRelayKeys,
  cleanSupabaseKey,
  cleanSupabaseUrl,
  configuredRelays,
  countUse,
  DEFAULT_OPT_IN,
  makeTransports,
  pairChannel,
  RelayRouter,
  useThisMonth,
  type BackupRelayKind,
  type RelayHealth,
  type RelayKeys,
  type RelayPath,
  type RelaySocket,
  type RelayTransport,
  type AwayNote,
  type AgentLabel,
  type AssignResult,
  type AssignTo,
  type HubCommandAction,
  type HubApproval,
  type HubAskNote,
  type HubBoardCommand,
  type HubCryptoKey,
  type DeviceFrame,
  type HubFrame,
  type HubInboxState,
  type HubInboxTask,
  type HubOptIn,
  type HubPresence,
  type InboxTaskView,
  type SealedBody,
  type SealedEnvelope,
  type TailscaleDirect,
} from "@kesher/shared";
import { inboxRunId, type ActivityBatch, type AgentActivity } from "./agent-activity.js";
import type { KesherConfig } from "./config.js";
import { hubBoardSnapshot } from "./hub-board.js";
import { parseHubDiag, type HubDiagSnapshot } from "./hub-diag.js";
import { pickRelay, relayList, type RelayProvider } from "./relay.js";
import type { TaskBoard } from "./task-board.js";

/** The hub part of KesherAI's config. */
export type HubSettings = KesherConfig["hub"];

/** A socket as this client uses it (the `ws` package in the app, a fake in tests). */
export interface HubSocket {
  send(text: string): void;
  close(): void;
  /** Drops a dead link at once, without the closing handshake (the watchdog); `close` when missing. */
  kill?(): void;
}

/** Callbacks a socket calls. */
export interface HubSocketEvents {
  open(): void;
  message(text: string): void;
  close(): void;
  /** Why the link failed (before `close`), e.g. "Unexpected server response: 401". */
  error?(message: string): void;
}

/** An approval waiting in a chat on this PC (sent to the phone through the relay). */
export interface PendingApproval {
  conversationId: string;
  requestId: string;
  title: string;
  tool: string;
  preview: string;
  reason: string;
  /** Who asks: a helper (sub-agent) by its task, or "Antigravity"; none for the chat's own agent. */
  who?: string;
  /** `run`: an "Run this task in Antigravity?" ask (one press, one run); otherwise an agent's step. */
  kind?: "tool" | "run";
  /** Whether the hub page may offer "Allow for a while" (the PC checks again when the answer comes). */
  forWhile?: boolean;
  /** When it was asked (ISO time). */
  at?: string;
  /** When the ask ends (ISO time); otherwise 30 minutes after `at` (the life of a sealed answer). */
  until?: string;
}

/** What the client needs from the app. */
export interface HubClientDeps {
  /** The live config section (changed in place, then saved with `persist`). */
  settings: () => HubSettings;
  persist: () => Promise<void>;
  board?: TaskBoard;
  /** A task for Antigravity also goes to the task inbox, where it waits for the user's Run (never started from here). */
  inbox?: (t: { taskId: string; title: string; spec: string }, boardId: string | undefined) => Promise<void>;
  /** Shows a notification on this PC (and its phone), like the rest of the app. */
  notify?: (title: string, body: string) => void;
  version: string;
  /** Whether this PC is busy now (self-work running, a heavy job). */
  busy?: () => boolean;
  /** The agents this PC has (a loaded model, Antigravity, a vendor session link). */
  agents?: () => HubAgent[];
  /** Approvals waiting in chats, and how to answer one. */
  approvals?: {
    pending(): PendingApproval[];
    /**
     * `from`: the device whose signed, sealed message carried the answer, and its kind as the hub lists it.
     * `forMinutes`: "Allow for a while" from the hub page (the app decides whether it applies; otherwise once).
     */
    answer(conversationId: string, requestId: string, decision: "allow" | "deny" | "clear", from?: { id: string; kind?: string }, forMinutes?: number): Promise<boolean>;
  };
  fetch?: typeof fetch;
  openSocket?: (url: string, on: HubSocketEvents) => HubSocket;
  /** The name shown on the hub until the user renames it. */
  deviceName?: string;
  /** Live agent activity (agent-activity.ts): Stop from the hub page reaches its runs, and it slows down when told to. */
  activity?: Pick<AgentActivity, "has" | "cancel" | "slowDown">;
  /** The task inbox's tasks (inbox-runner.ts), reported to the hub page's Tasks list as metadata. */
  inboxTasks?: () => Promise<InboxTaskView[]>;
  /**
   * Run or Cancel for a task-inbox task, pressed on the owner's paired phone or hub page (`from`: that verified
   * device). Returns whether it was done, or why not in a short line.
   */
  /** The inbox's "ask before the next task" settings per executor (reported with each task). */
  inboxAskNext?: () => { antigravity: boolean; local: boolean };
  inboxCommand?: (action: HubCommandAction, taskId: string, from: { id: string; kind: string }, on?: boolean) => Promise<{ ok: boolean; text: string }>;
  /** "Who does it" for a task or a work-list item, from the owner's phone or hub page (task-assign.ts). */
  assign?: (taskId: string, to: AssignTo, confirm: boolean) => Promise<AssignResult>;
  /** The models Antigravity offers (names, inbox-models.ts `pickableModels`), sent with tasks that have not started. */
  inboxModels?: () => string[];
  /** Picks the model of an Antigravity task ("" = the default for its kind), from the owner's phone or hub page. */
  inboxModel?: (taskId: string, model: string) => Promise<AssignResult>;
  /** Renames an agent run and sets its note, from the owner's phone or hub page (agent-labels.ts). */
  agentLabel?: (runId: string, label: AgentLabel, from: { id: string; kind: string }) => Promise<{ ok: boolean; text: string }>;
  /** Applies a board command (reopen, a higher priority, for self-work, a note) from the owner's phone or hub page (hub-board.ts). */
  boardCommand?: (taskId: string, cmd: HubBoardCommand) => Promise<{ ok: boolean; text: string }>;
  /** Another device wrote to the owner's Google Drive (a bare `sync` ping): pull now (tasks-sync.ts). */
  onSync?: () => void;
  /**
   * The hub's diagnostics (`GET /api/diag`), fetched after a failed connect and every 10 minutes while connected;
   * the app saves them to `logs/hub-diag.json` and the newest error to `main.log` (hub-diag.ts).
   */
  saveDiag?: (snap: HubDiagSnapshot, reason: string) => void;
  /**
   * This PC's tailnet-only addresses (tailscale-watch.ts), sent in the hello so the owner's phones can reach the PC
   * directly when the hub is down (direct-path.ts). Undefined without Tailscale.
   */
  direct?: () => TailscaleDirect | undefined;
  /** Opens a backup relay's WebSocket (relay-transport.ts); by default the `ws` package. A fake in tests. */
  openRelaySocket?: (url: string) => RelaySocket;
  /** The clock for the relay failover (a fake in tests). */
  now?: () => number;
}

/**
 * Why the link is not up, as a code the settings card words in Hebrew and English:
 * - `unreachable`: the hub did not answer (no internet, a wrong address, the hub is down).
 * - `refused`: the hub no longer knows this PC (removed on the hub page, or its token is gone): pair again.
 * - `socket`: the hub answered, but the live link (WebSocket) did not open or was cut; it retries by itself.
 * - `rate-limited`: too many tries for now; it retries by itself.
 * - `hub-error`: the hub answered with an error; it retries by itself.
 * - `dropped`: a message could not be opened and was dropped (the link itself is fine).
 * - `hub-limit`: the hub used up Cloudflare's daily storage quota; it tries again after 00:00 UTC (not every few minutes).
 */
export type HubErrorCode = "unreachable" | "refused" | "socket" | "rate-limited" | "hub-error" | "dropped" | "hub-limit";

/**
 * When to try again after the hub's daily quota ran out: a few minutes after the next 00:00 UTC (spread, so devices
 * do not all come at once).
 *
 * @param now - The time in ms.
 * @param jitter - 0..1 (default random).
 * @returns The time in ms.
 */
export function afterUtcMidnight(now: number, jitter = Math.random()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() + 60_000 + Math.floor(jitter * 4 * 60_000);
}

/** What the settings card shows (never the token or the key). */
export interface HubStatus {
  enabled: boolean;
  url?: string;
  paired: boolean;
  connected: boolean;
  paused: boolean;
  optIn: HubOptIn;
  /** While pairing: the code to approve on the hub page, and this PC's key fingerprint to compare. */
  pairing?: { code: string; fingerprint: string; expiresAt: string };
  /** The other devices as the hub shows them (names and on/off). */
  devices: Array<{ id: string; name: string; kind: string; online: boolean }>;
  /** The last problem in English (kept for older pages), and its code for the card's own words. */
  lastError?: string;
  errorCode?: HubErrorCode;
  /** ISO times: when the live link last opened, and when the next try is (while it is down). */
  lastConnectedAt?: string;
  nextRetryAt?: string;
  /** The backup relays (Settings › Kesher Cloud › Backup relays): which have keys (never the keys themselves). */
  relays: { ably: boolean; supabase: boolean; supabaseUrl?: string };
  /**
   * Where this PC's sealed messages go now (relay-failover.ts), each backup relay's health, and this month's messages
   * per relay (counted here, for the 80% rule).
   */
  path: RelayPath;
  relayHealth: Partial<Record<BackupRelayKind, RelayHealth>>;
  relayUse: { month: string; ably: number; supabase: number };
}

/**
 * A change to the backup relays' keys from Settings: a text sets a field, "" or null clears it, a missing field stays.
 */
export interface RelayKeysChange {
  ablyKey?: string | null;
  supabaseUrl?: string | null;
  supabaseKey?: string | null;
}

const BEAT_MS = 45_000;
/** A ping every 30 s (the hub answers it without waking up); a link that heard nothing for 100 s is dead. */
const PING_MS = 30_000;
const DEAD_MS = 100_000;
/** How often the approvals waiting on this PC are compared with the last snapshot sent (in memory; sent only on change). */
const APPROVALS_MS = 3000;
/** The hub's diagnostics are read this often while connected, and never more often than {@link DIAG_GAP_MS} after a failure. */
const DIAG_MS = 10 * 60_000;
const DIAG_GAP_MS = 60_000;
const MARK = /hub-task:([\w-]{1,64}):([\w-]{1,64})/;

/** How many of the newest inbox tasks are reported (older ones were reported when they changed). */
const INBOX_REPORTED = 40;

const INBOX_STATE: Record<InboxTaskView["status"], HubInboxState> = {
  waiting: "waiting",
  queued: "waiting",
  // A free-Gemini task deferred by its quota is mapped to "deferred" in hubInboxTask; Antigravity's waits for Run.
  "deferred-quota": "waiting-run",
  running: "running",
  "needs-approval": "running",
  done: "done",
  partial: "partial",
  failed: "failed",
  declined: "failed",
  skipped: "failed",
};

/**
 * A task-inbox task as the hub page lists it: metadata only (title, state, executor, branch, a short result), never
 * the task's text. Tasks that came from the hub are left out (the page that sent them already lists them).
 *
 * @param t - The task as the inbox keeps it.
 * @param now - The report time (ms).
 * @param order - Where it stands in the queue: its board item's priority (lower is more urgent) and its place among
 *   the waiting tasks (1 = next). Both optional; an older page ignores them.
 * @returns The report, or undefined when it is not reported.
 */
export function hubInboxTask(t: InboxTaskView, now: number, order: { priority?: number; queuePos?: number; askNext?: { antigravity: boolean; local: boolean }; models?: string[] } = {}): HubInboxTask | undefined {
  if (t.from === "hub" || !/^[\w-]{1,64}$/.test(t.id)) return undefined;
  let state = INBOX_STATE[t.status];
  // An Antigravity task waiting on the PC waits for the user's Run; a local one waits for self-work.
  if (state === "waiting" && t.runBy === "antigravity") state = "waiting-run";
  // Only the Gemini route has its own "deferred" state (it retries by itself at the reset); other routes keep the old
  // mapping so a page that does not know it yet still lists the task.
  if (t.status === "deferred-quota" && t.runBy === "gemini") state = "deferred";
  // A local task the local agent has claimed on the board is running (the queue keeps it "queued" until it ends).
  if (state === "waiting" && t.runBy === "local" && t.boardState === "claimed") state = "running";
  const ended = state === "done" || state === "partial" || state === "failed";
  const result = (ended ? (t.status === "skipped" ? "Skipped." : t.status === "declined" ? t.note : (t.summary ?? t.note)) : t.status === "needs-approval" ? "Waits for an approval on the PC or the phone." : t.note)?.replace(/\s+/g, " ").trim().slice(0, 300);
  const going = (t.runBy === "antigravity" && (state === "running" || state === "waiting-run")) || (t.runBy === "opencode" && state === "running");
  return {
    taskId: t.id,
    title: (t.title || t.id).slice(0, 200),
    state,
    executor: t.runBy === "opus" ? "claude" : t.runBy,
    from: t.from === "roee" || t.from === "self-work" ? t.from : "claude",
    // The branch shows once there is work on it (a started or ended run), never a planned name.
    ...(t.branch && (t.startedAt || ended) && t.status !== "declined" ? { branch: t.branch } : {}),
    ...(result ? { result } : {}),
    estSteps: estimateTaskSteps(t),
    ...(state === "running" && t.steps ? { steps: t.steps } : {}),
    ...(state === "deferred" && t.retryAt ? { retryAt: t.retryAt } : {}),
    ...(going ? { runId: inboxRunId(t.id) } : {}),
    // The hub's "who works on what": the model, the board item and its priority, the queue place, what it is, when it
    // started and ended, and the one-line cause of a stop (never the task's text).
    ...(t.modelUsed || t.model ? { model: (t.modelUsed || t.model)!.slice(0, 60) } : {}),
    ...(t.boardId && /^[\w-]{1,64}$/.test(t.boardId) ? { boardId: t.boardId } : {}),
    ...(order.priority !== undefined ? { priority: order.priority } : {}),
    ...(order.queuePos && (state === "waiting" || state === "waiting-run") ? { queuePos: order.queuePos } : {}),
    ...(t.queued ? { lineAt: t.queued } : {}),
    ...(t.standing ? { standing: true } : {}),
    // The model picker's choices, only for an Antigravity task that has not started (a running one keeps its model).
    ...(order.models?.length && t.runBy === "antigravity" && !t.startedAt && (state === "waiting" || state === "waiting-run") ? { models: order.models.slice(0, 12) } : {}),
    ...(order.askNext && (t.runBy === "antigravity" || t.runBy === "local") ? { askNext: order.askNext[t.runBy] } : {}),
    kind: workKindOf({ kind: t.kind, title: t.title, goal: t.goal }),
    ...(t.startedAt ? { startedAt: t.startedAt } : {}),
    ...(ended && t.endedAt ? { endedAt: t.endedAt } : {}),
    ...((state === "failed" || state === "deferred" || state === "partial") && result ? { cause: result.slice(0, 160) } : {}),
    at: now,
  };
}

/**
 * Checks a hub address: https, or http only for this computer (a local test hub).
 *
 * @param url - What the user typed.
 * @returns The address without a trailing slash, or undefined when it is not allowed.
 */
export function cleanHubUrl(url: string): string | undefined {
  try {
    const u = new URL(url.trim());
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return undefined;
    if (u.username || u.password || u.search || u.hash) return undefined;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** The default socket: the `ws` package, outward only. */
function wsSocket(url: string, on: HubSocketEvents): HubSocket {
  const ws = new WebSocket(url, { handshakeTimeout: 15_000, maxPayload: 64 * 1024 });
  ws.on("open", () => on.open());
  ws.on("message", (data) => on.message(String(data)));
  ws.on("close", () => on.close());
  // A refused upgrade (a 500 from the hub, say): its status and the start of its body say why, instead of a bare status.
  ws.on("unexpected-response", (_req, res) => {
    let body = "";
    res.on("data", (c: Buffer) => {
      if (body.length < 300) body += c.toString("utf8");
    });
    const done = () => {
      on.error?.(`Unexpected server response: ${res.statusCode} ${body.replace(/\s+/g, " ").slice(0, 160)}`.trim());
      ws.terminate();
    };
    res.on("end", done);
    res.on("error", done);
  });
  ws.on("error", (e) => on.error?.(e.message));
  return { send: (t) => ws.send(t), close: () => ws.close(), kill: () => ws.terminate() };
}

/** The PC's link to the cloud hub. */
export class HubClient {
  private socket?: HubSocket;
  private connected = false;
  private stopped = true;
  private paused = false;
  private retry = 0;
  private retryTimer?: NodeJS.Timeout;
  private beatTimer?: NodeJS.Timeout;
  private diagTimer?: NodeJS.Timeout;
  private diagAt = 0;
  private pingTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private approvalsTimer?: NodeJS.Timeout;
  /** When the hub was last heard from on the open link, when it last opened, and when the next try is. */
  private heardAt = 0;
  private connectedAt?: number;
  private retryAt?: number;
  private errorCode?: HubErrorCode;
  /** A ticket is being fetched (one try at a time), and which link is current (an old link's events are ignored). */
  private connecting = false;
  private gen = 0;
  private presence: HubPresence[] = [];
  private hubKey = "";
  private key?: Promise<{ privateKey: HubCryptoKey; publicKey: string }>;
  private readonly replay = new ReplayGuard();
  /** The failover between the hub and the backup relays (relay-failover.ts). */
  private readonly router: RelayRouter;
  /** The backup relays' transports (one per configured relay, in failover order) and the keys they were made with. */
  private transports: RelayTransport[] = [];
  private transportsKey = "";
  /** Each paired phone's channel on the backup relays, and back (a channel only carries its own pair's messages). */
  private channelOf = new Map<string, string>();
  private peerOf = new Map<string, string>();
  private relaySyncing?: Promise<void>;
  /** When the relay use was last saved (it is counted on every message, saved at most every few minutes). */
  private useSavedAt = 0;
  /** The hash of the relay keys last sent to each phone (in memory: each phone gets them again after a restart). */
  private readonly relaysSent = new Map<string, string>();
  /** The last approvals snapshot sent (its request ids), and the online phones it went to. */
  private approvalsKey = "";
  private approvalsTo = new Set<string>();
  /** The last board snapshot sent (a hash of it) and the online phones it went to; the board is reported on change only. */
  private boardKey = "";
  private boardTo = new Set<string>();
  /** A hub that refused the board snapshot (an older hub) is not sent it again on this connection. */
  private boardOff = false;
  private boardSentAt = 0;
  private boardTimer?: NodeJS.Timeout;
  private boardRun?: Promise<void>;
  private boardAgain = false;
  private pairing?: { code: string; fingerprint: string; expiresAt: number };
  private lastError?: string;
  private readonly fetch: typeof fetch;
  /** Relays that failed since the last good link (relay.ts): the next one in priority order is tried. */
  private readonly relayFailed = new Set<string>();
  /** `sync` pings, at most one per 5 seconds (the last one held back, never lost). */
  private readonly syncPings = syncPinger(() => {
    if (this.connected) this.send({ t: "sync" });
  });

  /** @param deps - Config, board, notifications and the outside calls. */
  constructor(private readonly deps: HubClientDeps) {
    this.router = new RelayRouter(deps.now ?? Date.now);
    this.fetch = deps.fetch ?? fetch;
  }

  /**
   * Tells the owner's other devices that this PC wrote to Google Drive, so they pull now instead of waiting for
   * their timers. Carries nothing; skipped while the link is down (the others' timers pull anyway).
   */
  pingSync(): void {
    if (this.connected) this.syncPings.ping();
  }

  private get s(): HubSettings {
    return this.deps.settings();
  }

  /** The backup relays' settings (filled in for a config saved before they existed). */
  private get relaysCfg(): HubSettings["relays"] {
    return (this.s.relays ??= {});
  }

  /** The relay in use now: the first in priority order that has not failed (today the one hub). */
  private get relay(): RelayProvider | undefined {
    return pickRelay(relayList(this.s), this.relayFailed);
  }

  /** The current relay's address (the hub address while there is only one). */
  private get relayUrl(): string | undefined {
    return this.relay?.url ?? this.s.url;
  }

  /** Marks the current relay as failed, so the next connect tries the next one (none yet: the same hub again). */
  private relayDown(): void {
    const r = this.relay;
    if (r && relayList(this.s).length > 1) this.relayFailed.add(r.id);
  }

  /**
   * Sends the hello again on an open link (this PC's Tailscale address changed), so the phones learn it now.
   */
  sayHello(): void {
    if (this.connected) this.send(this.helloFrame());
  }

  private helloFrame(): DeviceFrame {
    const direct = this.deps.direct?.();
    return { t: "hello", version: this.deps.version, platform: process.platform, busy: this.deps.busy?.() ?? false, optIn: cleanOptIn(this.s.optIn), agents: this.agents(), ...(direct ? { direct } : {}) };
  }

  /** @returns What the settings card shows (no secrets). */
  status(): HubStatus {
    const s = this.s;
    return {
      enabled: s.enabled,
      ...(s.url ? { url: s.url } : {}),
      paired: !!(s.token && s.deviceId),
      connected: this.connected,
      paused: this.paused,
      optIn: cleanOptIn(s.optIn),
      ...(this.pairing ? { pairing: { code: this.pairing.code, fingerprint: this.pairing.fingerprint, expiresAt: new Date(this.pairing.expiresAt).toISOString() } } : {}),
      devices: this.presence.filter((d) => d.id !== s.deviceId).map((d) => ({ id: d.id, name: d.name, kind: d.kind, online: d.online })),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
      ...(this.connectedAt ? { lastConnectedAt: new Date(this.connectedAt).toISOString() } : {}),
      ...(!this.connected && !this.stopped && this.retryAt ? { nextRetryAt: new Date(this.retryAt).toISOString() } : {}),
      path: this.relayOrder()[0] ?? "hub",
      relayHealth: Object.fromEntries(this.transports.map((t) => [t.kind, t.health()])),
      relayUse: useThisMonth(this.s.relayUse, this.now()),
      relays: { ably: !!this.relaysCfg.ablyKey, supabase: !!(this.relaysCfg.supabaseUrl && this.relaysCfg.supabaseKey), ...(this.relaysCfg.supabaseUrl ? { supabaseUrl: this.relaysCfg.supabaseUrl } : {}) },
    };
  }

  /** Records a problem (English for the log-free status, a code for the card's Hebrew and English). */
  private fail(code: HubErrorCode, text: string): void {
    this.errorCode = code;
    this.lastError = text;
  }

  // ---- settings ----

  /**
   * Sets the hub address. A different hub forgets the old pairing (its token belongs to the old hub).
   *
   * @param url - The address.
   */
  async setUrl(url: string): Promise<void> {
    const clean = cleanHubUrl(url);
    if (!clean) throw new Error("The hub address must start with https://");
    if (clean !== this.s.url) {
      this.stop();
      this.s.url = clean;
      delete this.s.token;
      delete this.s.deviceId;
      this.s.reported = [];
      await this.deps.persist();
    }
  }

  /**
   * Turns the hub link on or off.
   *
   * @param on - On or off.
   */
  async setEnabled(on: boolean): Promise<void> {
    this.s.enabled = on;
    await this.deps.persist();
    if (on) this.start();
    else this.stop();
  }

  /**
   * Changes what this PC accepts (tasks, local-model tasks, Antigravity tasks, vendor links) and tells the hub.
   *
   * @param change - The fields to change.
   */
  async setOptIn(change: Partial<HubOptIn>): Promise<void> {
    this.s.optIn = cleanOptIn({ ...this.s.optIn, ...change });
    await this.deps.persist();
    this.beat();
  }

  /**
   * Sets or clears the backup relays' keys (checked first; a bad one is refused with a short reason and nothing is
   * saved), then sends them sealed to the owner's phones, so they can use the same relays.
   *
   * @param change - The fields to set ("" or null clears one).
   */
  async setRelays(change: RelayKeysChange): Promise<void> {
    const next = { ...this.relaysCfg };
    const field = (name: keyof RelayKeysChange, clean: (v: unknown) => string | undefined, what: string) => {
      const v = change[name];
      if (v === undefined) return;
      if (v === null || v.trim() === "") return void delete next[name];
      const c = clean(v);
      if (!c) throw new Error(`That is not ${what}.`);
      next[name] = c;
    };
    field("ablyKey", cleanAblyKey, "an Ably API key (app.key:secret)");
    field("supabaseUrl", cleanSupabaseUrl, "a Supabase project URL (https://<project>.supabase.co)");
    field("supabaseKey", cleanSupabaseKey, "a Supabase anon key");
    this.s.relays = next;
    await this.deps.persist();
    this.relaysSent.clear();
    void this.sendRelays(true).catch(() => undefined);
    await this.syncRelays();
  }

  /** The backup relays' keys as the transports and the phones use them (only complete, well-formed ones). */
  relayKeys(): RelayKeys {
    const r = this.relaysCfg;
    return cleanRelayKeys({ ably: { key: r.ablyKey }, supabase: { url: r.supabaseUrl, anonKey: r.supabaseKey } });
  }

  /**
   * Sends the backup relays' keys, sealed, to each of the owner's online phones that has not had these keys yet (the hub
   * relays the envelope without being able to read it). Never to other kinds of device. Without keys nothing goes,
   * unless `force` (the keys were just cleared: the phones forget theirs).
   *
   * @param force - Send even when there are no keys.
   */
  async sendRelays(force = false): Promise<void> {
    if (!this.connected || !this.s.deviceId) return;
    const keys = this.relayKeys();
    if (!force && !Object.keys(keys).length) return;
    const hash = createHash("sha256").update(JSON.stringify(keys)).digest("base64url").slice(0, 16);
    const phones = this.presence.filter((d) => d.kind === "phone" && d.online && d.id !== this.s.deviceId && this.relaysSent.get(d.id) !== hash);
    for (const p of phones) if (await this.sendSealed(p.id, "relays", { type: "relays", keys, at: Date.now() }, HUB_LIMITS.approvalTtl)) this.relaysSent.set(p.id, hash);
  }

  // ---- backup relays (relay-transport.ts, relay-failover.ts) ----

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Whether sealed messages can go out now: the hub's live link, or a healthy backup relay. */
  private get linked(): boolean {
    return this.connected || this.transports.some((t) => t.health().healthy);
  }

  /**
   * The devices to send to: the hub's presence while it is up; while it is down, the paired phones kept from it
   * (their keys), counted as on (the backup relays do not know who is on).
   */
  private get devices(): HubPresence[] {
    if (this.connected || this.presence.length) return this.presence;
    return (this.s.peers ?? []).map((p) => ({ id: p.id, name: "", kind: p.kind === "pc" ? "pc" : "phone", publicKey: p.publicKey, online: true, busy: false, agents: [], optIn: DEFAULT_OPT_IN }) as HubPresence);
  }

  /** The paths to try for the next message, best first. */
  private relayOrder(): RelayPath[] {
    return this.router.order(this.transports.map((t) => ({ kind: t.kind, healthy: t.health().healthy })), this.s.relayUse);
  }

  /** Counts messages on a backup relay (for the 80% rule) and saves the count at most every 5 minutes. */
  private countRelay(kind: BackupRelayKind, n: number): void {
    this.s.relayUse = countUse(this.s.relayUse, kind, n, this.now());
    if (this.now() - this.useSavedAt > 5 * 60_000) {
      this.useSavedAt = this.now();
      void this.deps.persist().catch(() => undefined);
    }
  }

  /**
   * Brings the backup relays in line with the settings and the paired phones: makes (or closes) the transports when
   * the keys change, keeps the phones' keys for a start while the hub is down, and listens on each pair's channel.
   * Runs once at a time; a call while it runs runs it again after.
   */
  syncRelays(): Promise<void> {
    const run = async () => {
      const keys = this.relayKeys();
      const on = !this.stopped && this.s.enabled && !!this.s.deviceId && configuredRelays(keys).length > 0;
      const key = on ? createHash("sha256").update(JSON.stringify(keys)).digest("base64url") : "";
      if (key !== this.transportsKey) {
        for (const t of this.transports) t.close();
        this.transports = [];
        this.transportsKey = key;
        if (on) {
          const openSocket = this.deps.openRelaySocket ?? ((url: string) => new WebSocket(url, { handshakeTimeout: 15_000, maxPayload: 128 * 1024 }) as unknown as RelaySocket);
          this.transports = makeTransports(keys, { openSocket, fetch: this.fetch, now: () => this.now() });
          for (const t of this.transports) t.onEnvelope((env, channel) => void this.fromRelay(t.kind, env, channel).catch(() => undefined));
        }
      }
      if (!on) return;
      // The phones' keys, kept while the hub lists them (not secret), so a start while the hub is down still works.
      if (this.presence.length) {
        const peers = this.presence.filter((d) => d.kind === "phone" && d.id !== this.s.deviceId).slice(0, 20).map((d) => ({ id: d.id, kind: d.kind, publicKey: d.publicKey }));
        if (JSON.stringify(peers) !== JSON.stringify(this.s.peers ?? [])) {
          this.s.peers = peers;
          await this.deps.persist();
        }
      }
      const own = (await this.ownKey()).privateKey;
      const channelOf = new Map<string, string>();
      for (const p of this.devices.filter((d) => d.kind === "phone" && d.id !== this.s.deviceId)) channelOf.set(p.id, this.channelOf.get(p.id) ?? (await pairChannel(own, p.publicKey)));
      this.channelOf = channelOf;
      this.peerOf = new Map([...channelOf].map(([id, ch]) => [ch, id]));
      for (const t of this.transports) {
        t.setChannels([...channelOf.values()]);
        t.connect();
      }
    };
    const next = (this.relaySyncing ?? Promise.resolve()).then(run, run);
    this.relaySyncing = next.catch(() => undefined);
    return next;
  }

  /**
   * An envelope from a backup relay: only one addressed to this PC, from the phone the channel belongs to, is opened
   * (and dropped by its id when the same one already came through another path).
   */
  private async fromRelay(kind: BackupRelayKind, env: SealedEnvelope, channel: string): Promise<void> {
    if (env.to !== this.s.deviceId || this.peerOf.get(channel) !== env.from) return;
    this.countRelay(kind, 1);
    await this.onEnvelope(env, false);
  }

  /**
   * Sends one sealed envelope on the best path now: the hub's live link, or a backup relay (the next one when a
   * publish fails).
   *
   * @param env - The envelope.
   * @returns The path it went on, or undefined when nothing took it.
   */
  private async route(env: SealedEnvelope): Promise<RelayPath | undefined> {
    for (const path of this.relayOrder()) {
      if (path === "hub") {
        if (!this.socket) continue;
        this.send({ t: "send", env });
        return "hub";
      }
      const t = this.transports.find((x) => x.kind === path);
      const channel = this.channelOf.get(env.to);
      if (!t || !channel) continue;
      // The ask note rides in the hub's Web Push only; the relays carry the envelope itself.
      const { note: _note, waiting: _waiting, ...plain } = env;
      if (await t.publish(channel, plain)) {
        this.countRelay(path, 2);
        return path;
      }
    }
    return undefined;
  }

  /** Forgets the pairing, the token and this PC's key (the device should also be revoked on the hub page). */
  async forget(): Promise<void> {
    this.stop();
    delete this.s.token;
    delete this.s.deviceId;
    delete this.s.key;
    this.s.reported = [];
    this.s.enabled = false;
    this.key = undefined;
    this.pairing = undefined;
    await this.deps.persist();
  }

  // ---- keys and pairing ----

  /** This PC's key pair: made once and kept (encrypted) in the config. */
  private ownKey(): Promise<{ privateKey: HubCryptoKey; publicKey: string }> {
    this.key ??= (async () => {
      if (this.s.key) return importPrivateJwk(this.s.key);
      const k = await generateHubKeys(true);
      this.s.key = await exportPrivateJwk(k.privateKey);
      await this.deps.persist();
      return importPrivateJwk(this.s.key);
    })();
    return this.key;
  }

  private async post(path: string, body: unknown, token?: string): Promise<{ status: number; data: Record<string, unknown>; note?: string }> {
    const r = await this.fetch(`${this.relayUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text().catch(() => "");
    try {
      return { status: r.status, data: (JSON.parse(text) ?? {}) as Record<string, unknown> };
    } catch {
      // Not JSON (Cloudflare's own error page, say): its first words go into the error text.
      return { status: r.status, data: {}, ...(text ? { note: text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) } : {}) };
    }
  }

  /**
   * The exact failing step as the error text: `ticket 503 hub-storage-limit`, `ticket 500 hub-unavailable: <message>`.
   *
   * @param step - What was being done (`ticket`, `rotate`, `ticket after rotate`).
   * @param r - The answer.
   * @returns The text.
   */
  private stepText(step: string, r: { status: number; data: Record<string, unknown>; note?: string }): string {
    const code = typeof r.data.error === "string" ? r.data.error.slice(0, 80) : "";
    const message = typeof r.data.message === "string" && !code.startsWith("hub-storage") ? r.data.message : (r.note ?? "");
    return `${step} ${r.status}${code ? ` ${code}` : ""}${message ? `: ${message.slice(0, 160)}` : ""}`;
  }

  /**
   * Fetches the hub's diagnostics (`GET /api/diag`) and hands them to the app to save. Quiet on any failure; after a
   * failed connect it runs at most once a minute (the hub limits it too).
   *
   * @param reason - Why now (`ticket 500 …`, `every 10 minutes`).
   * @param force - Skip the one-a-minute gap (the 10-minute timer).
   */
  private async fetchDiag(reason: string, force = false): Promise<void> {
    if (!this.deps.saveDiag || !this.s.token || !this.s.url) return;
    if (!force && Date.now() - this.diagAt < DIAG_GAP_MS) return;
    this.diagAt = Date.now();
    try {
      const r = await this.fetch(`${this.relayUrl}/api/diag`, { headers: { authorization: `Bearer ${this.s.token}` }, signal: AbortSignal.timeout(15_000) });
      if (r.status !== 200) return;
      const snap = parseHubDiag(await r.json().catch(() => undefined));
      if (snap) this.deps.saveDiag(snap, reason);
    } catch {
      // The hub is not answering: the failure itself is in lastError.
    }
  }

  /**
   * Starts pairing: the hub gives a code to approve on its page; this PC then polls until it is approved.
   *
   * @returns The code, this PC's key fingerprint (to compare on the hub page) and when the code expires.
   */
  async pair(): Promise<{ code: string; fingerprint: string; expiresAt: string }> {
    if (!this.s.url) throw new Error("Set the hub address first.");
    const key = await this.ownKey();
    const name = (this.deps.deviceName ?? hostname()).slice(0, 60) || "PC";
    const r = await this.post("/api/pair/start", { publicKey: key.publicKey, kind: "pc", name });
    if (r.status !== 200 || typeof r.data.code !== "string" || typeof r.data.pollSecret !== "string") throw new Error(typeof r.data.error === "string" ? r.data.error : "The hub did not start pairing.");
    const expiresAt = Date.now() + Number(r.data.expiresIn ?? 300) * 1000;
    this.pairing = { code: r.data.code, fingerprint: await keyFingerprint(key.publicKey), expiresAt };
    this.pollPairing(r.data.pollSecret, expiresAt);
    return { code: this.pairing.code, fingerprint: this.pairing.fingerprint, expiresAt: new Date(expiresAt).toISOString() };
  }

  private pollPairing(pollSecret: string, until: number): void {
    clearTimeout(this.pollTimer);
    const tick = async (): Promise<void> => {
      if (Date.now() > until) {
        this.pairing = undefined;
        return;
      }
      try {
        const r = await this.post("/api/pair/poll", { pollSecret });
        if (r.data.status === "paired" && typeof r.data.token === "string" && typeof r.data.deviceId === "string") {
          this.s.token = r.data.token;
          this.s.deviceId = r.data.deviceId;
          this.s.reported = [];
          this.pairing = undefined;
          this.lastError = undefined;
          this.errorCode = undefined;
          // Pairing is the user's "yes": the link turns on and connects now (it used to wait for the On switch,
          // so a freshly paired PC showed Off on the hub page).
          this.s.enabled = true;
          await this.deps.persist();
          this.start();
          return;
        }
        if (r.status >= 400 && r.status !== 429) {
          this.pairing = undefined;
          this.fail("hub-error", typeof r.data.error === "string" ? r.data.error : "Pairing ended.");
          return;
        }
      } catch {
        // The hub did not answer: try again on the next tick.
      }
      this.pollTimer = setTimeout(() => void tick(), 3000);
      this.pollTimer.unref?.();
    };
    void tick();
  }

  // ---- connection ----

  /**
   * Connects when it is on and paired (called when the app starts, after pairing and by the On switch). Already
   * running but waiting to retry: tries again now, from a short backoff.
   */
  start(): void {
    if (!this.s.enabled || !this.s.token || !this.s.url) return;
    if (!this.stopped) {
      if (this.connected || this.connecting || this.socket) return;
      clearTimeout(this.retryTimer);
      this.retry = 0;
      void this.connect();
      return;
    }
    this.stopped = false;
    void this.connect();
    void this.syncRelays().catch(() => undefined);
  }

  /** Disconnects and stops reconnecting. */
  stop(): void {
    this.stopped = true;
    this.gen++;
    clearTimeout(this.retryTimer);
    clearInterval(this.beatTimer);
    clearInterval(this.diagTimer);
    clearInterval(this.pingTimer);
    clearInterval(this.approvalsTimer);
    clearTimeout(this.boardTimer);
    this.boardTimer = undefined;
    clearTimeout(this.inboxTimer);
    this.inboxTimer = undefined;
    clearTimeout(this.pollTimer);
    this.syncPings.cancel();
    this.socket?.close();
    this.socket = undefined;
    this.connected = false;
    this.router.hubClosed();
    this.retryAt = undefined;
    void this.syncRelays().catch(() => undefined);
  }

  /** Reconnects later: 1 s doubling to 5 minutes, with jitter. */
  private later(): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const base = Math.min(300_000, 1000 * 2 ** Math.min(this.retry++, 20));
    const wait = base / 2 + Math.random() * (base / 2);
    this.retryAt = Date.now() + wait;
    this.retryTimer = setTimeout(() => void this.connect(), wait);
    this.retryTimer.unref?.();
  }

  /** Reconnects at a set time (after the hub's daily quota resets); the backoff starts over then. */
  private laterAt(at: number): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retry = 0;
    this.retryAt = at;
    this.retryTimer = setTimeout(() => void this.connect(), Math.max(1000, at - Date.now()));
    this.retryTimer.unref?.();
  }

  /** Gets a one-use ticket (rotating the token when due), then opens the socket. */
  async connect(): Promise<void> {
    if (this.stopped || !this.s.token || !this.s.url || this.connecting || this.socket) return;
    this.connecting = true;
    try {
      await this.openLink();
    } finally {
      this.connecting = false;
    }
  }

  private async openLink(): Promise<void> {
    if (!this.s.token || !this.s.url) return;
    let ticket: string;
    try {
      let r = await this.post("/api/ticket", {}, this.s.token);
      if (this.stopped) return;
      if (r.status === 401 || r.status === 403) return this.lost("The hub no longer knows this PC. Pair it again.");
      if (r.status === 503 && r.data.error === "hub-storage-limit") {
        this.relayDown();
        this.router.hubFailed();
        this.fail("hub-limit", this.stepText("ticket", r));
        void this.fetchDiag(this.stepText("ticket", r));
        return this.laterAt(afterUtcMidnight(Date.now()));
      }
      if (r.status === 503 && (r.data.error === "hub-storage-error" || r.data.error === "hub-unavailable")) {
        this.fail("hub-error", this.stepText("ticket", r));
        void this.fetchDiag(this.stepText("ticket", r));
        return this.later();
      }
      if (r.status === 503) {
        this.paused = true;
        return this.later();
      }
      if (r.status === 429) {
        this.fail("rate-limited", "Too many tries; trying again soon.");
        return this.later();
      }
      if (r.status !== 200 || typeof r.data.ticket !== "string") {
        // Cloudflare's 1101 (the Worker threw): fail over to the backup relays at once.
        if (/\b1101\b/.test(this.stepText("ticket", r))) this.router.hubFailed();
        this.fail("hub-error", this.stepText("ticket", r));
        void this.fetchDiag(this.stepText("ticket", r));
        return this.later();
      }
      if (r.data.rotateDue === true) {
        const rot = await this.post("/api/rotate", {}, this.s.token);
        if (rot.status === 200 && typeof rot.data.token === "string") {
          this.s.token = rot.data.token;
          await this.deps.persist();
          r = await this.post("/api/ticket", {}, this.s.token);
          if (r.status !== 200 || typeof r.data.ticket !== "string") {
            this.fail("hub-error", this.stepText("ticket after rotate", r));
            void this.fetchDiag(this.stepText("ticket after rotate", r));
            return this.later();
          }
        }
      }
      ticket = String(r.data.ticket);
    } catch {
      this.fail("unreachable", "The hub did not answer.");
      this.relayDown();
      return this.later();
    }
    if (this.stopped) return;
    const ws = `${(this.relayUrl ?? this.s.url).replace(/^http/, "ws")}/ws/device?ticket=${encodeURIComponent(ticket)}`;
    const open = this.deps.openSocket ?? wsSocket;
    let opened = false;
    const gen = ++this.gen;
    this.socket = open(ws, {
      open: () => {
        if (this.gen !== gen) return;
        opened = true;
        this.connected = true;
        this.paused = false;
        this.retry = 0;
        this.retryAt = undefined;
        this.lastError = undefined;
        this.errorCode = undefined;
        this.connectedAt = this.heardAt = Date.now();
        this.relayFailed.clear();
        this.router.hubOpen();
        this.send(this.helloFrame());
        clearInterval(this.beatTimer);
        this.beatTimer = setInterval(() => this.beat(), BEAT_MS);
        this.beatTimer.unref?.();
        // The hub's own problem log, read every 10 minutes while connected.
        clearInterval(this.diagTimer);
        this.diagTimer = setInterval(() => void this.fetchDiag("every 10 minutes", true), DIAG_MS);
        this.diagTimer.unref?.();
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.ping(), PING_MS);
        this.pingTimer.unref?.();
        // New approvals reach the hub page within seconds (compared in memory; a snapshot goes only when they change).
        this.approvalsKey = "";
        this.approvalsTo.clear();
        this.boardKey = "";
        this.boardTo.clear();
        this.boardOff = false;
        clearInterval(this.approvalsTimer);
        this.approvalsTimer = setInterval(() => void this.sendApprovals().catch(() => undefined), APPROVALS_MS);
        this.approvalsTimer.unref?.();
      },
      message: (text) => {
        this.heardAt = Date.now();
        this.router.hubHeard();
        void this.onMessage(text).catch(() => undefined);
      },
      error: (message) => {
        if (opened) return;
        // "Unexpected server response: 500 {…}" is the upgrade being refused: name the step and the status.
        const m = /^Unexpected server response: (\d{3})\s*(.*)$/.exec(message);
        const text = m ? `socket upgrade ${m[1]}${m[2] ? `: ${m[2]}` : ""}` : `socket open failed: ${message.slice(0, 120)}`;
        this.fail("socket", text.slice(0, 220));
        void this.fetchDiag(text);
      },
      close: () => {
        if (this.gen !== gen) return;
        if (opened && !this.errorCode) this.fail("socket", "The live link was cut; reconnecting.");
        else if (!opened && !this.errorCode) {
          this.fail("socket", "socket closed before it opened");
          void this.fetchDiag("socket closed before it opened");
        }
        this.connected = false;
        this.router.hubClosed();
        clearInterval(this.beatTimer);
        clearInterval(this.diagTimer);
        clearInterval(this.pingTimer);
        clearInterval(this.approvalsTimer);
        clearTimeout(this.boardTimer);
        this.boardTimer = undefined;
        this.socket = undefined;
        this.later();
      },
    });
  }

  /**
   * Keeps the link honest: a ping the hub answers without waking up, and a link that heard nothing for a while (the
   * laptop slept, the network changed) is dropped so the reconnect starts, instead of looking connected forever while
   * the hub shows this PC as off.
   */
  private ping(): void {
    if (!this.connected || !this.socket) return;
    if (Date.now() - this.heardAt > DEAD_MS) {
      this.fail("socket", "The hub stopped answering on the live link; reconnecting.");
      const s = this.socket;
      (s.kill ?? s.close).call(s);
      return;
    }
    this.send({ t: "ping" });
  }

  /** The hub refused this PC: forget the token and stop. */
  private async lost(why: string): Promise<void> {
    this.stop();
    this.fail("refused", why);
    delete this.s.token;
    delete this.s.deviceId;
    await this.deps.persist();
  }

  private send(frame: unknown): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      // Closing: the next connection sends again.
    }
  }

  private agents(): HubAgent[] {
    const all = this.deps.agents?.() ?? [];
    return this.s.optIn.reportLinks ? all : all.map(({ link: _link, ...a }) => a);
  }

  /**
   * Tells the hub this PC is going to sleep or shutting down (with what was running), or is back, so the phone
   * shows "the PC went to sleep" at once instead of waiting for a timeout. Sent only on a live link, and quick.
   * An older hub refuses the frame; that changes nothing.
   *
   * @param state - "asleep" or "awake".
   * @param note - What was running (counts only).
   */
  announceAway(state: "asleep" | "awake", note: AwayNote = {}): void {
    if (this.connected) this.send({ t: "away", state, note: cleanAwayNote(note) });
  }

  /** The heartbeat: presence, then results and approvals to send. */
  beat(): void {
    if (!this.connected) return;
    this.send({ t: "beat", busy: this.deps.busy?.() ?? false, optIn: cleanOptIn(this.s.optIn), agents: this.agents() });
    void this.reportResults().catch(() => undefined);
    void this.sendApprovals().catch(() => undefined);
    void this.reportInbox().catch(() => undefined);
  }

  // ---- messages ----

  /**
   * One frame from the hub.
   *
   * @param text - The frame as received.
   */
  async onMessage(text: string): Promise<void> {
    let f: HubFrame;
    try {
      f = JSON.parse(text) as HubFrame;
    } catch {
      return;
    }
    switch (f.t) {
      case "welcome":
        this.hubKey = typeof f.hubKey === "string" ? f.hubKey : "";
        this.presence = Array.isArray(f.presence) ? f.presence : [];
        this.paused = f.paused === true;
        void this.reportInbox().catch(() => undefined);
        void this.reportBoard().catch(() => undefined);
        // Each new link sends the relay keys again to the phones that are on (in case one lost its storage).
        this.relaysSent.clear();
        void this.sendRelays().catch(() => undefined);
        void this.syncRelays().catch(() => undefined);
        return;
      case "presence":
        this.presence = Array.isArray(f.presence) ? f.presence : [];
        // A phone that just paired gets the inbox's tasks too, and a phone that came on the approvals waiting now.
        void this.reportInbox().catch(() => undefined);
        void this.sendApprovals().catch(() => undefined);
        void this.reportBoard().catch(() => undefined);
        void this.sendRelays().catch(() => undefined);
        void this.syncRelays().catch(() => undefined);
        return;
      case "pause":
        this.paused = f.paused === true;
        return;
      case "revoked":
        return this.lost("This PC was removed from the hub.");
      case "deliver":
        return this.onEnvelope(f.env);
      case "sync":
        return this.deps.onSync?.();
      case "refused":
        // Over the hub's rate (or the free plan's quota): live activity goes every 10 seconds for a while.
        if (f.code === "rate-limited") this.deps.activity?.slowDown();
        // An older hub does not know the board snapshot (it cannot read the frame): the board is not sent again on this link.
        if (f.code === "bad-frame" && Date.now() - this.boardSentAt < 10_000) this.boardOff = true;
        return;
      default:
        return;
    }
  }

  /**
   * Seals live agent activity to every paired phone (the hub page and the phone's Cloud tab are phones) and sends it
   * in as few `agents` frames as fit. Only when this PC's opt-in reports activity; nothing is queued when offline
   * (the next batch carries the whole state again).
   *
   * @param batches - One batch per run, from {@link AgentActivity}.
   */
  async sendActivity(batches: ActivityBatch[]): Promise<void> {
    if (!this.connected || !this.s.deviceId || !cleanOptIn(this.s.optIn).reportActivity) return;
    const viewers = this.presence.filter((d) => d.kind === "phone" && d.id !== this.s.deviceId);
    if (!viewers.length || !batches.length) return;
    const key = (await this.ownKey()).privateKey;
    let envs: SealedEnvelope[] = [];
    let size = 0;
    const flush = () => {
      if (envs.length) this.send({ t: "agents", envs });
      envs = [];
      size = 0;
    };
    for (const b of batches) {
      for (const v of viewers) {
        const env = { ...(await sealMessage({ from: this.s.deviceId, to: v.id, kind: "agent_event", ttl: 3600 }, { type: "agent_event", runId: b.runId, state: b.state, events: b.events }, key, v.publicKey)), run: b.runId, n: b.events.length };
        const chars = JSON.stringify(env).length;
        if (chars > HUB_LIMITS.ctChars) continue;
        if (envs.length >= HUB_LIMITS.agentFrameEnvs || size + chars > HUB_LIMITS.frameChars - 500) flush();
        envs.push(env);
        size += chars;
      }
    }
    flush();
  }

  /** The sender's public key (a paired device, or the hub itself). */
  private senderKey(from: string): string | undefined {
    if (from === "hub") return this.hubKey || undefined;
    return this.devices.find((d) => d.id === from)?.publicKey;
  }

  /** Seals and sends a message to a device. */
  private async sendSealed(to: string, kind: SealedEnvelope["kind"], body: SealedBody, ttl?: number, waiting?: number, note?: HubAskNote): Promise<boolean> {
    const pub = this.senderKey(to);
    if (!pub || !this.s.deviceId) return false;
    const own = (await this.ownKey()).privateKey;
    const env = await sealMessage({ from: this.s.deviceId, to, kind, ...(ttl ? { ttl } : {}) }, body, own, pub);
    // `approvals` only: the count in clear, for the hub's "N waiting for you" push (see SealedEnvelope.waiting).
    if (waiting !== undefined) env.waiting = waiting;
    // `approvals` only: the newest ask sealed to the same phone, for its notification with buttons (the hub copies
    // it into the push unread).
    if (note) env.note = await sealMessage({ from: this.s.deviceId, to, kind: "ask_note", ttl: HUB_LIMITS.approvalTtl }, { type: "ask_note", ask: note, waiting: waiting ?? 1 }, own, pub);
    return (await this.route(env)) !== undefined;
  }

  /**
   * One sealed envelope for this PC, from the hub or a backup relay.
   *
   * @param env - The envelope.
   * @param fromHub - It came from the hub (which waits for an ack); a relay's needs none.
   */
  private async onEnvelope(env: SealedEnvelope, fromHub = true): Promise<void> {
    if (!env || typeof env.id !== "string") return;
    const ack = () => {
      if (fromHub) this.send({ t: "ack", id: env.id });
    };
    const pub = this.senderKey(env.from);
    let body: SealedBody;
    try {
      if (!pub) throw new Error("unknown sender");
      body = await openEnvelope(env, (await this.ownKey()).privateKey, pub);
    } catch {
      // Not for this PC, changed on the way, or from a device the hub no longer lists: dropped (acked so it is not
      // sent again), never acted on.
      this.fail("dropped", "A message from the hub could not be opened and was dropped.");
      return ack();
    }
    if (!this.replay.first(env.id, env.ttl)) return ack();
    switch (body.type) {
      case "task":
        await this.takeTask(env.from, body);
        return ack();
      case "cancel":
        // Stop on an agent card (a run of this PC), or a hub task's cancel (its board item).
        if (this.deps.activity?.has(body.taskId)) await this.deps.activity.cancel(body.taskId);
        else await this.cancelTask(env.from, body.taskId);
        return ack();
      case "approval_answer": {
        // The envelope opened with the sender's own key, so `from` is that paired device. Only the owner's phones (the
        // phone app and the hub page, both paired by a code the signed-in owner approved) answer approvals.
        const kind = this.devices.find((d) => d.id === env.from)?.kind;
        if (kind === "phone") await this.deps.approvals?.answer(body.conversationId, body.requestId, body.decision, { id: env.from, kind }, body.forMinutes).catch(() => false);
        // The answered approval leaves the snapshot at once (not at the next check).
        void this.sendApprovals().catch(() => undefined);
        return ack();
      }
      case "command": {
        // Run / Cancel from the owner's paired phone or hub page only (the same check as an approval answer).
        const kind = this.devices.find((d) => d.id === env.from)?.kind;
        const failed = (e: Error) => ({ ok: false, text: e.message || "It did not work." });
        const r: AssignResult =
          kind !== "phone"
            ? { ok: false, text: "Only your phone or the hub page can do this." }
            : body.action === "assign" && body.model !== undefined
              ? !this.deps.inboxModel
                ? { ok: false, text: "This PC cannot pick a model from here yet." }
                : await this.deps.inboxModel(body.taskId, body.model).catch(failed)
            : body.action === "assign"
              ? !this.deps.assign || !body.to
                ? { ok: false, text: "This PC cannot give tasks to others yet." }
                : await this.deps.assign(body.taskId, body.to, body.confirm === true).catch(failed)
            : body.action === "board"
              ? !this.deps.boardCommand || !body.board
                ? { ok: false, text: "This PC cannot change its board from here yet." }
                : await this.deps.boardCommand(body.taskId, body.board).catch(failed)
            : body.action === "agent-label"
              ? !this.deps.agentLabel
                ? { ok: false, text: "This PC cannot name agents yet." }
                : await this.deps.agentLabel(body.taskId, body.label ?? {}, { id: env.from, kind }).catch(failed)
              : !this.deps.inboxCommand
                ? { ok: false, text: "This PC has no task inbox." }
                : await this.deps.inboxCommand(body.action, body.taskId, { id: env.from, kind }, body.on === true).catch(failed);
        if (kind === "phone") await this.sendSealed(env.from, "command_result", { type: "command_result", commandId: body.commandId, taskId: body.taskId, ok: r.ok, text: r.text.slice(0, 300), ...(r.ask ? { ask: r.ask } : {}) }, HUB_LIMITS.approvalTtl);
        return ack();
      }
      default:
        return ack();
    }
  }

  /** A task from the hub becomes a board item (once per task id), stored before the ack. */
  private async takeTask(from: string, t: Extract<SealedBody, { type: "task" }>): Promise<void> {
    const o = cleanOptIn(this.s.optIn);
    const allowed = o.acceptTasks && (t.executor !== "pc-local" || o.acceptLocal) && (t.executor !== "pc-antigravity" || o.acceptAntigravity);
    if (!allowed || !this.deps.board) {
      await this.sendSealed(from, "result", { type: "result", taskId: t.taskId, status: "blocked", text: "This PC does not take this kind of task (Settings > Cloud hub)." });
      return;
    }
    const board = await this.deps.board.read();
    const existing = board.tasks.find((x) => MARK.exec(x.details ?? "")?.[1] === t.taskId);
    let boardId = existing?.id;
    if (!existing) {
      const details = [t.spec, "", `Executor: ${t.executor}${t.executor === "pc-antigravity" ? " (waits for Run by hand)" : ""}`, `From the cloud hub: hub-task:${t.taskId}:${from}`].join("\n");
      const after = await this.deps.board.change("roee", [{ op: "add", title: t.title, details, size: t.executor === "pc-local" ? "small" : "big" }]);
      boardId = after.tasks.at(-1)?.id;
      this.deps.notify?.("A task from the cloud hub", t.title);
      if (t.executor === "pc-antigravity") await this.deps.inbox?.({ taskId: t.taskId, title: t.title, spec: t.spec }, boardId).catch(() => undefined);
    }
    await this.sendSealed(from, "progress", { type: "progress", taskId: t.taskId, line: `On this PC's task board as ${boardId ?? "?"}` });
  }

  /** A cancel from the phone: the board item is blocked (if it is not done yet). */
  private async cancelTask(from: string, taskId: string): Promise<void> {
    const board = this.deps.board;
    if (!board) return;
    const item = (await board.read()).tasks.find((x) => MARK.exec(x.details ?? "")?.[1] === taskId);
    if (!item || item.status === "done" || item.status === "blocked") return;
    await board.change("roee", [{ op: "block", id: item.id, result: "Cancelled from the cloud hub." }]);
    this.s.reported = [...this.s.reported, taskId].slice(-200);
    await this.deps.persist();
    await this.sendSealed(from, "result", { type: "result", taskId, status: "cancelled", text: "Cancelled." });
  }

  /** Sends back the result of hub tasks whose board item is now done or blocked (once each). */
  async reportResults(): Promise<void> {
    if (!this.deps.board || !this.linked) return;
    const reported = new Set(this.s.reported);
    let changed = false;
    for (const t of (await this.deps.board.read()).tasks) {
      const m = MARK.exec(t.details ?? "");
      if (!m || reported.has(m[1]!) || (t.status !== "done" && t.status !== "blocked")) continue;
      const sent = await this.sendSealed(m[2]!, "result", { type: "result", taskId: m[1]!, status: t.status, text: (t.result ?? "").slice(0, 4000) });
      if (!sent) continue;
      reported.add(m[1]!);
      changed = true;
    }
    if (changed) {
      this.s.reported = [...reported].slice(-200);
      await this.deps.persist();
    }
  }

  /**
   * Reports the task inbox to the owner's phones and the hub page (the Tasks list, marked "from Claude"): each task's
   * state, executor, branch and short result, sealed to each phone. Only what changed since the last report is sent;
   * a phone that is off gets it from the hub's queue when it comes on.
   */
  async reportInbox(): Promise<void> {
    // One report at a time; a call during one runs once more after it (so no change is missed or sent twice).
    if (this.inboxRun) {
      this.inboxAgain = true;
      return this.inboxRun;
    }
    this.inboxRun = (async () => {
      try {
        do {
          this.inboxAgain = false;
          await this.reportInboxOnce();
        } while (this.inboxAgain);
      } finally {
        this.inboxRun = undefined;
      }
    })();
    return this.inboxRun;
  }

  private inboxRun?: Promise<void>;
  private inboxTimer?: NodeJS.Timeout;

  /**
   * The task inbox changed (a task started, queued, ended, asked or lost its "Run this?" ask): reports the tasks and
   * the open asks to the phones and the hub page within a moment (changes in a row make one send, at most 250 ms
   * later), so a card never keeps offering Run after the task has started.
   */
  scheduleInbox(): void {
    if (this.inboxTimer) return;
    this.inboxTimer = setTimeout(() => {
      this.inboxTimer = undefined;
      void this.reportInbox().catch(() => undefined);
      void this.sendApprovals().catch(() => undefined);
    }, 250);
    this.inboxTimer.unref?.();
  }
  private inboxAgain = false;

  private async reportInboxOnce(): Promise<void> {
    if (!this.deps.inboxTasks || !this.linked || !this.s.deviceId) return;
    const phones = this.devices.filter((d) => d.kind === "phone" && d.id !== this.s.deviceId);
    if (!phones.length) return;
    const now = Date.now();
    const tasks = (await this.deps.inboxTasks()).slice(-INBOX_REPORTED);
    // The board's priorities, and the queue order of the tasks that wait (the inbox lists them oldest first).
    const prio = new Map((await this.deps.board?.read().catch(() => undefined))?.tasks.map((b) => [b.id, b.priority]) ?? []);
    let place = 0;
    const sent = { ...this.s.inboxSent };
    let changed = false;
    for (const t of tasks) {
      const base = hubInboxTask(t, now);
      const waits = base?.state === "waiting" || base?.state === "waiting-run";
      const askNext = this.deps.inboxAskNext?.();
      const models = this.deps.inboxModels?.();
      const report = base && hubInboxTask(t, now, { ...(askNext ? { askNext } : {}), ...(models?.length ? { models } : {}), ...(t.boardId && prio.has(t.boardId) ? { priority: prio.get(t.boardId)! } : {}), ...(waits ? { queuePos: ++place } : {}) });
      if (!report) continue;
      const { at: _at, ...shape } = report;
      const hash = createHash("sha256").update(JSON.stringify(shape)).digest("base64url").slice(0, 16);
      for (const p of phones) {
        const key = `${p.id}/${report.taskId}`;
        if (sent[key] === hash) continue;
        if (!(await this.sendSealed(p.id, "inbox_task", { type: "inbox_task", ...report }, HUB_LIMITS.maxTtl))) continue;
        delete sent[key];
        sent[key] = hash;
        changed = true;
      }
    }
    if (changed) {
      // The newest 600 entries are kept (insertion order).
      this.s.inboxSent = Object.fromEntries(Object.entries(sent).slice(-600));
      await this.deps.persist();
    }
  }

  /**
   * Schedules a board report a moment from now (the board changed; several changes in a row make one report).
   * Called by the board's change listener: the board is never polled.
   */
  scheduleBoard(): void {
    if (this.boardTimer || !this.linked) return;
    this.boardTimer = setTimeout(() => {
      this.boardTimer = undefined;
      void this.reportBoard().catch(() => undefined);
    }, 1500);
    this.boardTimer.unref?.();
  }

  /**
   * Reports the shared task board to the owner's online phones and hub pages: one sealed snapshot (metadata only,
   * capped, see hub-board.ts) that replaces the last, sent when it changed and to a phone that just came on. Offline
   * phones get nothing (it would only queue on the hub); they get the current board when they come on.
   */
  async reportBoard(): Promise<void> {
    // One report at a time; a call during one runs once more after it.
    if (this.boardRun) {
      this.boardAgain = true;
      return this.boardRun;
    }
    this.boardRun = (async () => {
      try {
        do {
          this.boardAgain = false;
          await this.reportBoardOnce();
        } while (this.boardAgain);
      } finally {
        this.boardRun = undefined;
      }
    })();
    return this.boardRun;
  }

  private async reportBoardOnce(): Promise<void> {
    if (!this.deps.board || !this.linked || !this.s.deviceId || this.boardOff) return;
    const phones = this.devices.filter((d) => d.kind === "phone" && d.online && d.id !== this.s.deviceId);
    if (!phones.length) {
      this.boardTo.clear();
      return;
    }
    const board = await this.deps.board.read();
    const snap = hubBoardSnapshot(board);
    const key = createHash("sha256").update(JSON.stringify(snap)).digest("base64url").slice(0, 16);
    const changed = key !== this.boardKey;
    const to = changed ? phones : phones.filter((p) => !this.boardTo.has(p.id));
    this.boardKey = key;
    this.boardTo = new Set(phones.map((p) => p.id));
    if (!to.length) return;
    const at = Date.now();
    this.boardSentAt = at;
    for (const p of to) await this.sendSealed(p.id, "board", { type: "board", rev: board.rev, ...snap, at }, HUB_LIMITS.approvalTtl);
  }

  /**
   * Sends everything waiting for approval on this PC (chats, their sub-agents, Antigravity's Run asks) to the owner's
   * online phones and hub pages, as one sealed snapshot that replaces the last: when the set changes, and to a phone
   * that just came on. The hub only relays it (it cannot read it). When the set changes, the owner's phones that are
   * off get it too (queued for 30 minutes): its clear `waiting` count is how the hub knows to push "N waiting for you"
   * to a phone whose page is closed.
   */
  async sendApprovals(): Promise<void> {
    if (!this.deps.approvals || !this.linked || !this.s.deviceId) return;
    const allPhones = this.devices.filter((d) => d.kind === "phone" && d.id !== this.s.deviceId);
    const phones = allPhones.filter((d) => d.online);
    const pending = this.deps.approvals.pending();
    const items = fitApprovals(pending.map(toHubApproval));
    const key = items.map((a) => a.requestId).join(",");
    const changed = key !== this.approvalsKey;
    const to = changed ? allPhones : phones.filter((p) => !this.approvalsTo.has(p.id));
    this.approvalsKey = key;
    this.approvalsTo = new Set(phones.map((p) => p.id));
    if (!to.length || (!items.length && !changed)) return;
    const at = Date.now();
    const note = askNoteOf(pending, at);
    for (const p of to) await this.sendSealed(p.id, "approvals", { type: "approvals", items, at }, HUB_LIMITS.approvalTtl, Math.min(pending.length, 999), note);
  }
}

/**
 * The newest ask waiting on this PC, as the phone's notification shows it (with Run / Not now or Approve / Deny).
 * Its expiry is the ask's own, or 30 minutes after it was asked (an answer lives no longer on the hub).
 *
 * @param pending - What waits, as the app lists it.
 * @param now - The time now (ms), for an ask with no time.
 * @returns The note, or undefined when nothing waits (or the newest ask has already ended).
 */
export function askNoteOf(pending: readonly PendingApproval[], now: number): HubAskNote | undefined {
  const time = (s: string | undefined) => (s ? Date.parse(s) : NaN);
  let newest: PendingApproval | undefined;
  for (const a of pending) if (!newest || (time(a.at) || 0) >= (time(newest.at) || 0)) newest = a;
  if (!newest) return undefined;
  const at = Number.isFinite(time(newest.at)) ? time(newest.at) : now;
  const until = Number.isFinite(time(newest.until)) ? time(newest.until) : at + HUB_LIMITS.approvalTtl * 1000;
  if (until <= now) return undefined;
  const title = (newest.kind === "run" ? newest.title.replace(/^Run in Antigravity\? /, "") : newest.title || newest.tool).slice(0, HUB_LIMITS.noteTitleChars);
  return { requestId: newest.requestId, conversationId: newest.conversationId, kind: newest.kind ?? "tool", title, until };
}

/**
 * One approval as the hub page lists it (the PC's words, capped by {@link fitApprovals}).
 *
 * @param a - The approval as the app lists it.
 * @returns The hub's shape.
 */
export function toHubApproval(a: PendingApproval): HubApproval {
  const at = a.at ? Date.parse(a.at) : NaN;
  return { requestId: a.requestId, conversationId: a.conversationId, title: a.title, tool: a.tool, ...(a.who ? { who: a.who } : {}), reason: a.reason, preview: a.preview, kind: a.kind ?? "tool", forWhile: a.forWhile === true, at: Number.isFinite(at) ? at : 0 };
}
