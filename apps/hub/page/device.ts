/**
 * The hub page as a paired device. The hub never holds task text, so the page that sends tasks is itself a device
 * (kind "phone"): it keeps its own key (a non-extractable WebCrypto key in IndexedDB), pairs by code like any other
 * device, seals each task to the PC it routes to (or to the hub for the Claude cloud path), and keeps the tasks and
 * their results here in the browser ("the tasks and history are kept on your phone"). Same protocol and sealing code
 * as the PC and the phone app (`packages/shared/src/hub-*.ts`, compiled with this page).
 */
import { generateHubKeys, keyFingerprint, openEnvelope, randomB64url, ReplayGuard, sealMessage, type HubCryptoKey } from "../../../packages/shared/src/hub-crypto.js";
import { DEFAULT_OPT_IN, HUB_LIMITS, type HubExecutor, type HubFrame, type HubIfOffline, type HubPresence, type HubRefusal, type SealedEnvelope } from "../../../packages/shared/src/hub-protocol.js";
import { chooseRoute, type RouteDecision } from "../../../packages/shared/src/hub-route.js";
import { applyAgentBatch, type AgentCard } from "../../../packages/shared/src/hub-agents.js";

/** This browser's identity at the hub. */
interface Identity {
  deviceId: string;
  token: string;
  hubKey: string;
  privateKey: HubCryptoKey;
  publicKey: string;
  name: string;
}

/** A pairing this browser started and is waiting on. */
export interface PendingPair {
  code: string;
  fingerprint: string;
  expiresAt: number;
}

/** Where a task is. */
export type TaskStatus = "outbox" | "sent" | "waiting" | "running" | "done" | "failed" | "blocked" | "cancelled";

/** One task this browser sent; kept only here. */
export interface PageTask {
  taskId: string;
  /** The last envelope sent for it (to match the hub's sent/refused answers). */
  envId?: string;
  title: string;
  spec: string;
  executor: HubExecutor;
  ifOffline: HubIfOffline;
  route: RouteDecision["route"];
  to: string | null;
  toName: string;
  createdAt: number;
  status: TaskStatus;
  /** The latest progress line, or the result text. */
  line?: string;
  link?: string;
  branch?: string;
  /** What happened, for the task's timeline. */
  history: Array<{ t: number; he: string; en: string }>;
}

// ---- IndexedDB (one key-value store; structured clone keeps the CryptoKey usable but not exportable) ----

const DB = "kesher-hub";
let dbp: Promise<IDBDatabase> | undefined;

/** Opens the page's database. */
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

/** Reads one value. */
async function get<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("kv").objectStore("kv").get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

/** Writes (or, with undefined, deletes) one value. */
async function put(key: string, value: unknown): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("kv", "readwrite");
    if (value === undefined) tx.objectStore("kv").delete(key);
    else tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * A POST to this hub (same origin, so the browser sends `Origin` for the CSRF check).
 *
 * @param path - The API path.
 * @param body - The JSON body.
 * @param token - A device token, for the device routes.
 * @returns The status and the parsed answer.
 */
export async function post(path: string, body: unknown = {}, token?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, data: ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
}

/** Why the hub refused, in words. */
const REFUSAL: Record<HubRefusal, { he: string; en: string }> = {
  "bad-frame": { he: "ההודעה לא תקינה", en: "The message was not valid" },
  "rate-limited": { he: "יותר מדי משימות בזמן קצר", en: "Too many tasks in a short time" },
  paused: { he: "המרכז מושהה", en: "The hub is paused" },
  "no-recipient": { he: "המכשיר כבר לא מחובר למרכז", en: "That device is no longer paired" },
  "not-accepting": { he: "המחשב לא מקבל משימות (הגדרות › ענן Kesher במחשב)", en: "That PC does not take tasks (Settings › Kesher Cloud on the PC)" },
  "too-big": { he: "המשימה ארוכה מדי", en: "The task is too long" },
  "cloud-off": { he: "המסלול ל-Claude בענן כבוי או לא מוגדר", en: "The Claude cloud path is off or not set up" },
  "cloud-failed": { he: "Claude בענן לא התחיל את המשימה", en: "Claude cloud did not start the task" },
  "not-allowed": { he: "לא מותר", en: "Not allowed" },
};

/** The browser's device: identity, socket, presence and tasks. One per page. */
export class HubDevice {
  private ident?: Identity;
  private ws?: WebSocket;
  private retry = 0;
  private retryTimer?: number;
  private pingTimer?: number;
  private pollTimer?: number;
  private readonly replay = new ReplayGuard();
  private listeners = new Set<() => void>();
  /** The devices as the hub shows them (PCs that appear, and phones). */
  presence: HubPresence[] = [];
  connected = false;
  paused = false;
  tasks: PageTask[] = [];
  pending?: PendingPair;
  error?: { he: string; en: string };
  /** Live agent runs of the PCs, by device and run (in memory; the hub keeps 7 days and the page catches up). */
  agents = new Map<string, AgentCard>();
  /** Actions sent from an agent card and not yet answered by a new state ("stop", "allow", "deny"), by card key. */
  agentActions = new Map<string, string>();
  private agentSeq = 0;
  private catchingUp = false;

  /** Loads the saved identity and tasks, and connects when paired. */
  async load(): Promise<void> {
    try {
      this.ident = await get<Identity>("device");
      this.tasks = (await get<PageTask[]>("tasks")) ?? [];
    } catch {
      // IndexedDB blocked (some private windows): the page still works for signing in and managing.
    }
    if (this.ident) this.connect();
  }

  /** Whether this browser is paired with the hub. */
  get paired(): boolean {
    return !!this.ident;
  }

  /** This browser's device id, when paired. */
  get id(): string | undefined {
    return this.ident?.deviceId;
  }

  /** This browser's device name, when paired. */
  get name(): string | undefined {
    return this.ident?.name;
  }

  /**
   * Calls back on every change (presence, tasks, connection).
   *
   * @param cb - The callback.
   * @returns A function that stops it.
   */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }

  private async saveTasks(): Promise<void> {
    // The newest 200 are kept (older ones were finished long ago).
    this.tasks = this.tasks.slice(0, 200);
    await put("tasks", this.tasks).catch(() => undefined);
    this.changed();
  }

  // ---- pairing ----

  /**
   * Starts pairing this browser: a new key, a code to approve on a signed-in hub page, and polling until approved.
   *
   * @param name - The name for this browser in the device list.
   * @returns The code and the fingerprint to compare, or an error message.
   */
  async startPairing(name: string): Promise<PendingPair | { error: string }> {
    const keys = await generateHubKeys(false);
    const r = await post("/api/pair/start", { publicKey: keys.publicKey, kind: "phone", name: name.slice(0, HUB_LIMITS.nameChars) });
    if (r.status !== 200 || typeof r.data.code !== "string" || typeof r.data.pollSecret !== "string") return { error: typeof r.data.error === "string" ? r.data.error : "The hub did not start pairing." };
    const fingerprint = await keyFingerprint(keys.publicKey);
    this.pending = { code: r.data.code, fingerprint, expiresAt: Date.now() + Number(r.data.expiresIn ?? 300) * 1000 };
    const pollSecret = r.data.pollSecret;
    const tick = async (): Promise<void> => {
      if (!this.pending || Date.now() > this.pending.expiresAt) {
        this.pending = undefined;
        return this.changed();
      }
      const p = await post("/api/pair/poll", { pollSecret }).catch(() => undefined);
      if (p?.data.status === "paired" && typeof p.data.token === "string" && typeof p.data.deviceId === "string") {
        this.ident = { deviceId: p.data.deviceId, token: p.data.token, hubKey: typeof p.data.hubKey === "string" ? p.data.hubKey : "", privateKey: keys.privateKey, publicKey: keys.publicKey, name };
        await put("device", this.ident).catch(() => undefined);
        this.pending = undefined;
        this.changed();
        return this.connect();
      }
      if (p && p.status >= 400 && p.status !== 429) {
        this.pending = undefined;
        return this.changed();
      }
      this.pollTimer = window.setTimeout(() => void tick(), 3000);
    };
    void tick();
    this.changed();
    return this.pending;
  }

  /** Stops waiting on a pairing. */
  cancelPairing(): void {
    clearTimeout(this.pollTimer);
    this.pending = undefined;
    this.changed();
  }

  /** Forgets this browser's key, token and tasks (the hub page's "forget this browser"). */
  async forget(): Promise<void> {
    this.stop();
    this.ident = undefined;
    this.presence = [];
    this.tasks = [];
    this.agents.clear();
    this.agentSeq = 0;
    await put("device", undefined).catch(() => undefined);
    await put("tasks", undefined).catch(() => undefined);
    this.changed();
  }

  // ---- the socket ----

  private stop(): void {
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = undefined;
    this.connected = false;
  }

  /** Connects (a one-use ticket, then the socket); reconnects with backoff. */
  connect(): void {
    if (!this.ident || this.ws) return;
    void (async () => {
      const id = this.ident!;
      const t = await post("/api/ticket", {}, id.token).catch(() => undefined);
      if (t?.status === 401) {
        // Revoked at the hub: this browser is no longer a device.
        this.error = { he: "הדפדפן הזה נותק מהמרכז", en: "This browser was disconnected from the hub" };
        return void this.forget();
      }
      if (!t || t.status !== 200 || typeof t.data.ticket !== "string") {
        this.paused = t?.status === 503;
        return this.later();
      }
      if (t.data.rotateDue === true) {
        const r = await post("/api/rotate", {}, id.token).catch(() => undefined);
        if (r?.status === 200 && typeof r.data.token === "string") {
          id.token = r.data.token;
          await put("device", id).catch(() => undefined);
        }
      }
      const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/device?ticket=${encodeURIComponent(t.data.ticket)}`);
      this.ws = ws;
      ws.onopen = () => {
        this.retry = 0;
        ws.send(JSON.stringify({ t: "hello", version: "hub-page", platform: "web", busy: false, optIn: DEFAULT_OPT_IN, agents: [] }));
        // Pings are answered by the hub without waking it (free while idle).
        this.pingTimer = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"t":"ping"}'), 30_000);
      };
      ws.onmessage = (e) => void this.onFrame(String(e.data));
      ws.onclose = () => {
        clearInterval(this.pingTimer);
        this.ws = undefined;
        this.connected = false;
        this.changed();
        this.later();
      };
    })();
  }

  private later(): void {
    if (!this.ident) return;
    const base = Math.min(120_000, 1000 * 2 ** this.retry++);
    this.retryTimer = window.setTimeout(() => this.connect(), base / 2 + Math.random() * (base / 2));
  }

  private sendFrame(frame: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private async onFrame(text: string): Promise<void> {
    let f: HubFrame | { t: "pong" };
    try {
      f = JSON.parse(text) as HubFrame;
    } catch {
      return;
    }
    switch (f.t) {
      case "welcome":
        this.connected = true;
        this.paused = f.paused;
        this.presence = f.presence;
        if (this.ident && f.hubKey && f.hubKey !== this.ident.hubKey) {
          this.ident.hubKey = f.hubKey;
          await put("device", this.ident).catch(() => undefined);
        }
        this.changed();
        void this.catchUpAgents();
        return this.flushOutbox();
      case "presence":
        this.presence = f.presence;
        return this.changed();
      case "pause":
        this.paused = f.paused;
        return this.changed();
      case "revoked":
        this.error = { he: "הדפדפן הזה נותק מהמרכז", en: "This browser was disconnected from the hub" };
        return this.forget();
      case "sent":
        return this.mark(f.id, (task) => {
          task.status = f.queued ? "waiting" : task.route === "claude-cloud" ? "running" : "sent";
          task.history.push(f.queued ? { t: Date.now(), he: "ממתין במרכז עד שהמחשב יידלק", en: "Waiting at the hub until the PC is on" } : { t: Date.now(), he: "נמסר", en: "Delivered" });
        });
      case "refused": {
        if (!f.id) return;
        const why = REFUSAL[f.code] ?? REFUSAL["not-allowed"];
        return this.mark(f.id, (task) => {
          task.status = "failed";
          task.line = why[document.documentElement.lang === "en" ? "en" : "he"];
          task.history.push({ t: Date.now(), ...why });
        });
      }
      case "deliver":
        return this.onDeliver(f.env);
      default:
        return;
    }
  }

  private async mark(envId: string, change: (t: PageTask) => void): Promise<void> {
    const task = this.tasks.find((t) => t.envId === envId);
    if (!task) return;
    change(task);
    await this.saveTasks();
  }

  /**
   * Fetches the agent activity kept for this browser since the last one it has (after a reconnect, like SSE's
   * `Last-Event-ID`), a page of 500 at a time.
   */
  private async catchUpAgents(): Promise<void> {
    const id = this.ident;
    if (!id || this.catchingUp) return;
    this.catchingUp = true;
    try {
      for (let page = 0; page < 10; page++) {
        const r = await fetch(`/api/agents?since=${this.agentSeq}`, { credentials: "same-origin", headers: { authorization: `Bearer ${id.token}` } }).catch(() => undefined);
        if (!r?.ok) return;
        const data = (await r.json().catch(() => ({}))) as { envs?: SealedEnvelope[]; more?: boolean };
        for (const env of Array.isArray(data.envs) ? data.envs : []) await this.onAgentEvent(env, false);
        this.changed();
        if (!data.more) return;
      }
    } finally {
      this.catchingUp = false;
    }
  }

  /** One sealed activity batch (live or caught up): opened with its PC's key and applied to its card. */
  private async onAgentEvent(env: SealedEnvelope, live: boolean): Promise<void> {
    const id = this.ident;
    const senderKey = this.presence.find((d) => d.id === env.from)?.publicKey;
    if (!id || !senderKey) return;
    let body;
    try {
      body = await openEnvelope(env, id.privateKey, senderKey);
    } catch {
      return; // Tampered or not for us: ignored (activity is never acked; the hub keeps only a short ring).
    }
    if (body.type !== "agent_event" || body.runId !== env.run) return;
    const seq = typeof env.seq === "number" ? env.seq : 0;
    this.agentSeq = Math.max(this.agentSeq, seq);
    const card = applyAgentBatch(this.agents, env.from, body, typeof env.at === "number" ? env.at : Date.now(), seq);
    // A new state answers a pending Stop or Approve: the card shows the PC's word again.
    if (body.events.length) this.agentActions.delete(`${card.deviceId}/${card.runId}`);
    if (live) this.changed();
  }

  /**
   * Stops an agent run on its PC (a sealed `cancel`; the PC stops it like its own Stop button).
   *
   * @param c - The card.
   * @returns Whether it was sent.
   */
  async stopAgent(c: AgentCard): Promise<boolean> {
    return this.sendToAgent(c, "cancel", { type: "cancel", taskId: c.runId }, "stop");
  }

  /**
   * Answers what a waiting run asks (a helper's question, a step's approval, Antigravity's Run): the existing sealed
   * `approval_answer`, which the PC accepts only from a paired phone.
   *
   * @param c - The card (its state says what it waits for).
   * @param decision - Allow (Run, Approve, Yes) or deny.
   * @returns Whether it was sent.
   */
  async answerAgent(c: AgentCard, decision: "allow" | "deny"): Promise<boolean> {
    const w = c.state.waiting;
    if (!w) return false;
    return this.sendToAgent(c, "approval_answer", { type: "approval_answer", requestId: w.requestId, conversationId: w.conversationId, decision }, decision);
  }

  private async sendToAgent(c: AgentCard, kind: "cancel" | "approval_answer", body: Parameters<typeof sealMessage>[1], action: string): Promise<boolean> {
    const id = this.ident;
    const pc = this.presence.find((d) => d.id === c.deviceId);
    if (!id || !pc?.online || !this.connected) return false;
    const env = await sealMessage({ from: id.deviceId, to: pc.id, kind }, body, id.privateKey, pc.publicKey);
    if (!this.sendFrame({ t: "send", env })) return false;
    this.agentActions.set(`${c.deviceId}/${c.runId}`, action);
    this.changed();
    return true;
  }

  /** A sealed message for this browser: a PC's progress or result, or the hub's "Claude cloud started". */
  private async onDeliver(env: SealedEnvelope): Promise<void> {
    const id = this.ident;
    if (!id) return;
    if (env.kind === "agent_event") return this.onAgentEvent(env, true);
    const senderKey = env.from === "hub" ? id.hubKey : this.presence.find((d) => d.id === env.from)?.publicKey;
    if (!senderKey) return; // A sender not in presence (yet): it comes again on the next connect.
    let body;
    try {
      body = await openEnvelope(env, id.privateKey, senderKey);
    } catch {
      return void this.sendFrame({ t: "ack", id: env.id }); // Tampered or not for us: drop it.
    }
    // Approvals are answered in the KesherAI app; left queued for it (they expire in 30 minutes).
    if (body.type === "approval_request") return;
    this.sendFrame({ t: "ack", id: env.id });
    if (!this.replay.first(env.id, env.ttl)) return;
    const task = "taskId" in body ? this.tasks.find((t) => t.taskId === body.taskId) : undefined;
    if (!task) return;
    const now = Date.now();
    if (body.type === "progress") {
      task.status = "running";
      task.line = body.line;
    } else if (body.type === "result") {
      task.status = body.status;
      task.line = body.text;
      if (body.link) task.link = body.link;
      if (body.branch) task.branch = body.branch;
      task.history.push({ t: now, he: { done: "הסתיים", failed: "נכשל", blocked: "נתקע", cancelled: "בוטל" }[body.status], en: { done: "Done", failed: "Failed", blocked: "Blocked", cancelled: "Cancelled" }[body.status] });
    } else if (body.type === "cloud_started") {
      if (body.error) {
        task.status = "failed";
        task.line = body.error;
        task.history.push({ t: now, he: "Claude בענן לא התחיל", en: "Claude cloud did not start" });
      } else {
        task.status = "running";
        if (body.sessionUrl) task.link = body.sessionUrl;
        task.history.push({ t: now, he: "התחיל ב-Claude בענן", en: "Started in Claude cloud" });
      }
    }
    await this.saveTasks();
  }

  // ---- tasks ----

  /**
   * Where a task would go now, with its reason and cost (the send form's route line).
   *
   * @param executor - Who should do it.
   * @param ifOffline - What to do when no PC is on.
   * @param cloudAvailable - Whether the Claude cloud path is set up and on (from the signed-in state; assumed when unknown).
   * @returns The decision.
   */
  route(executor: HubExecutor, ifOffline: HubIfOffline, cloudAvailable: boolean): RouteDecision {
    return chooseRoute({ executor, ifOffline }, this.presence, { cloudAvailable: cloudAvailable && !!this.ident?.hubKey });
  }

  /**
   * Sends a task: routes it, seals it to the recipient, and keeps it here. Without a connection it waits in the
   * outbox and goes when the page connects.
   *
   * @param text - What to do (first line is the title).
   * @param executor - Who should do it.
   * @param ifOffline - What to do when no PC is on.
   * @param cloudAvailable - Whether the Claude cloud path is available.
   * @returns The task, or an error when nowhere can take it.
   */
  async send(text: string, executor: HubExecutor, ifOffline: HubIfOffline, cloudAvailable: boolean): Promise<PageTask | { error: { he: string; en: string } }> {
    const spec = text.trim().slice(0, HUB_LIMITS.specChars);
    if (!spec) return { error: { he: "כתוב מה לעשות", en: "Write what to do" } };
    const r = this.route(executor, ifOffline, cloudAvailable);
    if (r.route === "none" || !r.to) return { error: r.reason };
    const toName = r.to === "hub" ? "Claude cloud" : (this.presence.find((d) => d.id === r.to)?.name ?? "PC");
    const task: PageTask = { taskId: randomB64url(12), title: spec.split("\n")[0]!.slice(0, 120), spec, executor, ifOffline, route: r.route, to: r.to, toName, createdAt: Date.now(), status: "outbox", history: [{ t: Date.now(), he: `נוצר · נותב: ${r.reason.he}`, en: `Created · routed: ${r.reason.en}` }] };
    this.tasks.unshift(task);
    await this.saveTasks();
    await this.deliver(task);
    return task;
  }

  /** Seals and sends one task (or leaves it in the outbox while offline). */
  private async deliver(task: PageTask): Promise<void> {
    const id = this.ident;
    if (!id || !this.connected || !task.to) return;
    const recipient = task.to === "hub" ? id.hubKey : this.presence.find((d) => d.id === task.to)?.publicKey;
    if (!recipient) {
      task.status = "failed";
      task.line = REFUSAL["no-recipient"][document.documentElement.lang === "en" ? "en" : "he"];
      return this.saveTasks();
    }
    const env = await sealMessage({ from: id.deviceId, to: task.to, kind: task.route === "claude-cloud" ? "cloud" : "task" }, { type: "task", taskId: task.taskId, title: task.title, spec: task.spec, executor: task.executor, ifOffline: task.ifOffline, createdAt: new Date(task.createdAt).toISOString() }, id.privateKey, recipient);
    task.envId = env.id;
    if (this.sendFrame({ t: "send", env })) await this.saveTasks();
  }

  /** Sends what waited for a connection. */
  private async flushOutbox(): Promise<void> {
    for (const t of this.tasks.filter((x) => x.status === "outbox")) await this.deliver(t);
  }

  /**
   * Sends a task again (after it failed or expired), routed again from now.
   *
   * @param task - The old task.
   * @param cloudAvailable - Whether the Claude cloud path is available.
   * @param executor - Another executor (e.g. "claude-cloud" for "send to the cloud instead").
   * @returns The new task or an error.
   */
  resend(task: PageTask, cloudAvailable: boolean, executor: HubExecutor = task.executor): Promise<PageTask | { error: { he: string; en: string } }> {
    return this.send(task.spec, executor, task.ifOffline, cloudAvailable);
  }

  /**
   * Removes a task from this browser (an outbox one is never sent).
   *
   * @param taskId - The task.
   */
  async remove(taskId: string): Promise<void> {
    this.tasks = this.tasks.filter((t) => t.taskId !== taskId);
    await this.saveTasks();
  }

  /**
   * Whether a waiting task is past what the hub keeps (24 hours), so it is shown as expired.
   *
   * @param t - The task.
   * @returns True when expired.
   */
  static expired(t: PageTask): boolean {
    return (t.status === "waiting" || t.status === "outbox") && Date.now() - t.createdAt > HUB_LIMITS.defaultTtl * 1000;
  }
}
