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
import { hostname } from "node:os";
import WebSocket from "ws";
import {
  cleanOptIn,
  exportPrivateJwk,
  HUB_LIMITS,
  generateHubKeys,
  importPrivateJwk,
  keyFingerprint,
  openEnvelope,
  ReplayGuard,
  sealMessage,
  type HubAgent,
  type HubCryptoKey,
  type HubFrame,
  type HubOptIn,
  type HubPresence,
  type SealedBody,
  type SealedEnvelope,
} from "@kesher/shared";
import type { ActivityBatch, AgentActivity } from "./agent-activity.js";
import type { KesherConfig } from "./config.js";
import type { TaskBoard } from "./task-board.js";

/** The hub part of KesherAI's config. */
export type HubSettings = KesherConfig["hub"];

/** A socket as this client uses it (the `ws` package in the app, a fake in tests). */
export interface HubSocket {
  send(text: string): void;
  close(): void;
}

/** Callbacks a socket calls. */
export interface HubSocketEvents {
  open(): void;
  message(text: string): void;
  close(): void;
}

/** An approval waiting in a chat on this PC (sent to the phone through the relay). */
export interface PendingApproval {
  conversationId: string;
  requestId: string;
  title: string;
  tool: string;
  preview: string;
  reason: string;
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
    /** `from`: the device whose signed, sealed message carried the answer, and its kind as the hub lists it. */
    answer(conversationId: string, requestId: string, decision: "allow" | "deny", from?: { id: string; kind?: string }): Promise<boolean>;
  };
  fetch?: typeof fetch;
  openSocket?: (url: string, on: HubSocketEvents) => HubSocket;
  /** The name shown on the hub until the user renames it. */
  deviceName?: string;
  /** Live agent activity (agent-activity.ts): Stop from the hub page reaches its runs, and it slows down when told to. */
  activity?: Pick<AgentActivity, "has" | "cancel" | "slowDown">;
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
  lastError?: string;
}

const BEAT_MS = 45_000;
const MARK = /hub-task:([\w-]{1,64}):([\w-]{1,64})/;

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
  ws.on("error", () => undefined);
  return { send: (t) => ws.send(t), close: () => ws.close() };
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
  private pollTimer?: NodeJS.Timeout;
  private presence: HubPresence[] = [];
  private hubKey = "";
  private key?: Promise<{ privateKey: HubCryptoKey; publicKey: string }>;
  private readonly replay = new ReplayGuard();
  private readonly sentApprovals = new Set<string>();
  private pairing?: { code: string; fingerprint: string; expiresAt: number };
  private lastError?: string;
  private readonly fetch: typeof fetch;

  /** @param deps - Config, board, notifications and the outside calls. */
  constructor(private readonly deps: HubClientDeps) {
    this.fetch = deps.fetch ?? fetch;
  }

  private get s(): HubSettings {
    return this.deps.settings();
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
    };
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

  private async post(path: string, body: unknown, token?: string): Promise<{ status: number; data: Record<string, unknown> }> {
    const r = await this.fetch(`${this.s.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: r.status, data: ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
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
          await this.deps.persist();
          if (this.s.enabled) this.start();
          return;
        }
        if (r.status >= 400 && r.status !== 429) {
          this.pairing = undefined;
          this.lastError = typeof r.data.error === "string" ? r.data.error : "Pairing ended.";
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

  /** Connects when it is on and paired (called at start-up too). */
  start(): void {
    if (!this.s.enabled || !this.s.token || !this.s.url || !this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  /** Disconnects and stops reconnecting. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.beatTimer);
    clearTimeout(this.pollTimer);
    this.socket?.close();
    this.socket = undefined;
    this.connected = false;
  }

  /** Reconnects later: 1 s doubling to 5 minutes, with jitter. */
  private later(): void {
    if (this.stopped) return;
    const base = Math.min(300_000, 1000 * 2 ** this.retry++);
    this.retryTimer = setTimeout(() => void this.connect(), base / 2 + Math.random() * (base / 2));
    this.retryTimer.unref?.();
  }

  /** Gets a one-use ticket (rotating the token when due), then opens the socket. */
  async connect(): Promise<void> {
    if (this.stopped || !this.s.token || !this.s.url) return;
    let ticket: string;
    try {
      let r = await this.post("/api/ticket", {}, this.s.token);
      if (r.status === 401) return this.lost("The hub no longer knows this PC. Pair it again.");
      if (r.status === 503) {
        this.paused = true;
        return this.later();
      }
      if (r.status !== 200 || typeof r.data.ticket !== "string") return this.later();
      if (r.data.rotateDue === true) {
        const rot = await this.post("/api/rotate", {}, this.s.token);
        if (rot.status === 200 && typeof rot.data.token === "string") {
          this.s.token = rot.data.token;
          await this.deps.persist();
          r = await this.post("/api/ticket", {}, this.s.token);
          if (r.status !== 200 || typeof r.data.ticket !== "string") return this.later();
        }
      }
      ticket = String(r.data.ticket);
    } catch {
      this.lastError = "The hub did not answer.";
      return this.later();
    }
    const ws = `${this.s.url.replace(/^http/, "ws")}/ws/device?ticket=${encodeURIComponent(ticket)}`;
    const open = this.deps.openSocket ?? wsSocket;
    this.socket = open(ws, {
      open: () => {
        this.connected = true;
        this.paused = false;
        this.retry = 0;
        this.lastError = undefined;
        this.send({ t: "hello", version: this.deps.version, platform: process.platform, busy: this.deps.busy?.() ?? false, optIn: cleanOptIn(this.s.optIn), agents: this.agents() });
        clearInterval(this.beatTimer);
        this.beatTimer = setInterval(() => this.beat(), BEAT_MS);
        this.beatTimer.unref?.();
      },
      message: (text) => void this.onMessage(text).catch(() => undefined),
      close: () => {
        this.connected = false;
        clearInterval(this.beatTimer);
        this.socket = undefined;
        this.later();
      },
    });
  }

  /** The hub refused this PC: forget the token and stop. */
  private async lost(why: string): Promise<void> {
    this.stop();
    this.lastError = why;
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

  /** The heartbeat: presence, then results and approvals to send. */
  beat(): void {
    if (!this.connected) return;
    this.send({ t: "beat", busy: this.deps.busy?.() ?? false, optIn: cleanOptIn(this.s.optIn), agents: this.agents() });
    void this.reportResults().catch(() => undefined);
    void this.sendApprovals().catch(() => undefined);
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
        return;
      case "presence":
        this.presence = Array.isArray(f.presence) ? f.presence : [];
        return;
      case "pause":
        this.paused = f.paused === true;
        return;
      case "revoked":
        return this.lost("This PC was removed from the hub.");
      case "deliver":
        return this.onEnvelope(f.env);
      case "refused":
        // Over the hub's rate (or the free plan's quota): live activity goes every 10 seconds for a while.
        if (f.code === "rate-limited") this.deps.activity?.slowDown();
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
    return this.presence.find((d) => d.id === from)?.publicKey;
  }

  /** Seals and sends a message to a device. */
  private async sendSealed(to: string, kind: SealedEnvelope["kind"], body: SealedBody): Promise<boolean> {
    const pub = this.senderKey(to);
    if (!pub || !this.s.deviceId) return false;
    const env = await sealMessage({ from: this.s.deviceId, to, kind }, body, (await this.ownKey()).privateKey, pub);
    this.send({ t: "send", env });
    return true;
  }

  private async onEnvelope(env: SealedEnvelope): Promise<void> {
    if (!env || typeof env.id !== "string") return;
    const ack = () => this.send({ t: "ack", id: env.id });
    const pub = this.senderKey(env.from);
    let body: SealedBody;
    try {
      if (!pub) throw new Error("unknown sender");
      body = await openEnvelope(env, (await this.ownKey()).privateKey, pub);
    } catch {
      // Not for this PC, changed on the way, or from a device the hub no longer lists: dropped (acked so it is not
      // sent again), never acted on.
      this.lastError = "A message from the hub could not be opened and was dropped.";
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
      case "approval_answer":
        // The envelope opened with the sender's own key, so `from` is that paired device.
        await this.deps.approvals?.answer(body.conversationId, body.requestId, body.decision, { id: env.from, ...(this.presence.find((d) => d.id === env.from)?.kind ? { kind: this.presence.find((d) => d.id === env.from)!.kind } : {}) }).catch(() => false);
        return ack();
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
    if (!this.deps.board || !this.connected) return;
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

  /** Sends new approvals waiting in chats to the phones, so they can be answered through the relay. */
  async sendApprovals(): Promise<void> {
    if (!this.deps.approvals || !this.connected) return;
    const phones = this.presence.filter((d) => d.kind === "phone");
    if (!phones.length) return;
    for (const a of this.deps.approvals.pending()) {
      if (this.sentApprovals.has(a.requestId)) continue;
      this.sentApprovals.add(a.requestId);
      for (const p of phones) await this.sendSealed(p.id, "approval_request", { type: "approval_request", ...a });
    }
    if (this.sentApprovals.size > 500) this.sentApprovals.clear();
  }
}
