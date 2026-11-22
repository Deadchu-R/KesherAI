/**
 * The hub page as a paired device. The hub never holds task text, so the page that sends tasks is itself a device
 * (kind "phone"): it keeps its own key (a non-extractable WebCrypto key in IndexedDB), pairs by code like any other
 * device, seals each task to the PC it routes to (or to the hub for the Claude cloud path), and keeps the tasks and
 * their results here in the browser ("the tasks and history are kept on your phone"). Same protocol and sealing code
 * as the PC and the phone app (`packages/shared/src/hub-*.ts`, compiled with this page).
 */
import { generateHubKeys, keyFingerprint, openEnvelope, randomB64url, ReplayGuard, sealMessage } from "../../../packages/shared/src/hub-crypto.js";
import { dropLocalPush } from "./push.js";
import { get, put } from "./kv.js";
import { DEFAULT_OPT_IN, HUB_LIMITS, syncPinger } from "../../../packages/shared/src/hub-protocol.js";
import { chooseRoute } from "../../../packages/shared/src/hub-route.js";
import { applyAgentBatch, RUN_STARTING_MS, runStarting } from "../../../packages/shared/src/hub-agents.js";
import { sameLabel } from "../../../packages/shared/src/agent-label.js";
import { inboxMetaOf } from "../../../packages/shared/src/hub-work.js";
import { RunUndo } from "../../../packages/shared/src/run-undo.js";
import { rememberDirect } from "./direct.js";
/** The timeline words for an inbox task's states. */
const INBOX_LABEL = {
    waiting: { he: "ממתין", en: "Waiting" },
    "waiting-run": { he: "ממתין ל\"הפעל\"", en: "Waiting for Run" },
    deferred: { he: "נדחה: מכסה", en: "Deferred: quota" },
    running: { he: "רץ", en: "Running" },
    done: { he: "הסתיים", en: "Done" },
    partial: { he: "הסתיים חלקית", en: "Partly done" },
    failed: { he: "נכשל", en: "Failed" },
};
// IndexedDB: the page's one key-value store (kv.ts, shared with the service worker, which reads the device's key to
// answer from a notification).
export { get, put } from "./kv.js";
/**
 * A POST to this hub (same origin, so the browser sends `Origin` for the CSRF check).
 *
 * @param path - The API path.
 * @param body - The JSON body.
 * @param token - A device token, for the device routes.
 * @returns The status and the parsed answer.
 */
export async function post(path, body = {}, token) {
    const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, data: ((await r.json().catch(() => ({}))) ?? {}) };
}
/** Why the hub refused, in words. */
const REFUSAL = {
    "bad-frame": { he: "ההודעה לא תקינה", en: "The message was not valid" },
    "rate-limited": { he: "יותר מדי משימות בזמן קצר", en: "Too many tasks in a short time" },
    paused: { he: "המרכז מושהה", en: "The hub is paused" },
    "no-recipient": { he: "המכשיר כבר לא מחובר למרכז", en: "That device is no longer paired" },
    "not-accepting": { he: "המחשב לא מקבל משימות (הגדרות › ענן Kesher במחשב)", en: "That PC does not take tasks (Settings › Kesher Cloud on the PC)" },
    "too-big": { he: "המשימה ארוכה מדי", en: "The task is too long" },
    "cloud-off": { he: "המסלול ל-Claude בענן כבוי או לא מוגדר", en: "The Claude cloud path is off or not set up" },
    "cloud-failed": { he: "Claude בענן לא התחיל את המשימה", en: "Claude cloud did not start the task" },
    "not-allowed": { he: "לא מותר", en: "Not allowed" },
    "storage-limit": { he: "המחשב כבוי, והמרכז הגיע היום למגבלת האחסון של Cloudflare; נסה שוב כשהמחשב פועל או אחרי חצות UTC", en: "The PC is off and the hub reached Cloudflare's storage limit today; try again when the PC is on or after midnight UTC" },
};
/** The browser's device: identity, socket, presence and tasks. One per page. */
export class HubDevice {
    ident;
    /** The PC keys last written for the service worker (see keepPcKeys). */
    pcKeysText = "";
    ws;
    retry = 0;
    retryTimer;
    pingTimer;
    pollTimer;
    replay = new ReplayGuard();
    listeners = new Set();
    /** The devices as the hub shows them (PCs that appear, and phones). */
    presence = [];
    connected = false;
    paused = false;
    tasks = [];
    pending;
    error;
    /** Live agent runs of the PCs, by device and run (in memory; the hub keeps 7 days and the page catches up). */
    agents = new Map();
    /** Actions sent from an agent card and not yet answered by a new state ("stop", "allow", "deny"), by card key. */
    agentActions = new Map();
    /**
     * Names and notes sent from here (by card key): waiting for the PC (shown at once), saved (shown until the run's new
     * state comes, at most 15 seconds), or the PC's "no" in its words.
     */
    agentLabels = new Map();
    /**
     * "Who does it" sent from here (by task or work-list item id): waiting for the PCs, then the answer; `ask` is the
     * PC's question before it stops a running task or runs a finished one again (in memory only).
     */
    assignActions = new Map();
    /**
     * What waits for the owner on each PC (its newest sealed snapshot; in memory, the PC sends it again when the page
     * connects), and the answers sent from here that the PC has not taken yet, by `<pc id>/<request id>`.
     */
    approvals = new Map();
    approvalActions = new Map();
    /**
     * Each PC's shared task board (its newest sealed snapshot, in memory; the PC sends it again when the page connects),
     * and the board commands sent from here by `<pc id>/<task id>`: waiting for the PC, then its answer.
     */
    boards = new Map();
    boardActions = new Map();
    /** Run / Cancel sent for a task (by task id): waiting for the PC's answer, then its answer (in memory only). */
    taskActions = new Map();
    agentSeq = 0;
    catchingUp = false;
    /** Called when another device wrote to Google Drive (its bare `sync` ping). */
    syncListeners = new Set();
    /** This page's own `sync` pings, at most one per 5 seconds (the last one held back, never lost). */
    syncPings = syncPinger(() => void this.sendFrame({ t: "sync" }), { setTimer: (cb, ms) => window.setTimeout(cb, ms), clearTimer: (t) => window.clearTimeout(t) });
    /** Loads the saved identity and tasks, and connects when paired. */
    async load() {
        try {
            this.ident = await get("device");
            this.tasks = (await get("tasks")) ?? [];
        }
        catch {
            // IndexedDB blocked (some private windows): the page still works for signing in and managing.
        }
        if (this.ident)
            this.connect();
    }
    /** Whether this browser is paired with the hub. */
    get paired() {
        return !!this.ident;
    }
    /** This browser's device id, when paired. */
    get id() {
        return this.ident?.deviceId;
    }
    /** This browser's device name, when paired. */
    get name() {
        return this.ident?.name;
    }
    /**
     * Calls back on every change (presence, tasks, connection).
     *
     * @param cb - The callback.
     * @returns A function that stops it.
     */
    onChange(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
    changed() {
        for (const cb of this.listeners)
            cb();
    }
    /** Run taps that are in their 5-second undo window, and what each sends when it ends (nothing is sent before). */
    runUndo = new RunUndo();
    runSends = new Map();
    undoTimer;
    /**
     * A tap on Run (or Start, or Run all): the button turns into "Starting in 5… Undo" and `send` runs only when the 5
     * seconds are over. A second tap while it counts changes nothing.
     *
     * @param key - The task id, the approval's request id, or {@link RUN_ALL_KEY}.
     * @param send - Sends the command (called once, after the window).
     */
    armRun(key, send) {
        if (this.runUndo.left(key, Date.now()) === undefined)
            this.runSends.set(key, send);
        this.runUndo.arm(key, Date.now());
        this.tickUndo();
    }
    /** Undo: the window closes and nothing is sent. */
    undoRun(key) {
        this.runUndo.cancel(key);
        this.runSends.delete(key);
        this.tickUndo();
    }
    /** The seconds "Starting in N…" shows for a key, or undefined when no window is open. */
    runCountdown(key) {
        return this.runUndo.left(key, Date.now());
    }
    /** Sends what is due and redraws; ticks every 250 ms only while a window is open. */
    tickUndo() {
        for (const k of this.runUndo.due(Date.now())) {
            const send = this.runSends.get(k);
            this.runSends.delete(k);
            send?.();
        }
        if (this.runUndo.active && this.undoTimer === undefined)
            this.undoTimer = window.setInterval(() => this.tickUndo(), 250);
        else if (!this.runUndo.active && this.undoTimer !== undefined) {
            window.clearInterval(this.undoTimer);
            this.undoTimer = undefined;
        }
        this.changed();
    }
    /** The tasks "Run all" would run: waiting for Run on a PC that is on, not already starting or sent. */
    runnableTasks() {
        return this.tasks.filter((t) => this.canRun(t) && !this.runStarting(t) && !this.taskActions.get(t.taskId));
    }
    /**
     * Run all, after its undo window: sends Run for every task that waits for it. The PC runs the first and queues the
     * rest; after each it asks "Next in line — Start?", so nothing runs without its own Start.
     */
    async runAll() {
        const all = this.runnableTasks();
        // A task whose own 5 seconds are still counting goes with this one: its window closes so it is not sent twice.
        for (const t of all)
            this.undoRun(t.taskId);
        // The first runs; the rest join the line (a second Run while one runs is refused by the PC).
        for (const [i, t] of all.entries())
            await this.inboxCommand(t, i === 0 ? "inbox-run" : "inbox-queue");
    }
    /**
     * "Ask before the next task" for an executor, sent to every PC that is on (the PC keeps the setting and reports it
     * with each task).
     *
     * @param executor - Antigravity or the local model.
     * @param on - Ask (true) or start the next queued task by itself (false).
     */
    async setAskNext(executor, on) {
        const id = this.ident;
        if (!id || !this.connected)
            return;
        for (const pc of this.onlinePcs()) {
            const env = await sealMessage({ from: id.deviceId, to: pc.id, kind: "command" }, { type: "command", commandId: randomB64url(12), action: "inbox-asknext", taskId: executor, on }, id.privateKey, pc.publicKey);
            this.sendFrame({ t: "send", env });
        }
    }
    /**
     * Calls back when another device wrote to the owner's Google Drive (pull now instead of at the next timer).
     *
     * @param cb - The callback.
     * @returns A function that stops it.
     */
    onSyncPing(cb) {
        this.syncListeners.add(cb);
        return () => this.syncListeners.delete(cb);
    }
    /** Tells the owner's other devices that this page wrote to Google Drive (a bare ping; skipped while offline). */
    pingSync() {
        if (this.connected)
            this.syncPings.ping();
    }
    async saveTasks() {
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
    async startPairing(name) {
        const keys = await generateHubKeys(false);
        const r = await post("/api/pair/start", { publicKey: keys.publicKey, kind: "phone", name: name.slice(0, HUB_LIMITS.nameChars) });
        if (r.status !== 200 || typeof r.data.code !== "string" || typeof r.data.pollSecret !== "string")
            return { error: typeof r.data.error === "string" ? r.data.error : "The hub did not start pairing." };
        const fingerprint = await keyFingerprint(keys.publicKey);
        this.pending = { code: r.data.code, fingerprint, expiresAt: Date.now() + Number(r.data.expiresIn ?? 300) * 1000 };
        const pollSecret = r.data.pollSecret;
        const tick = async () => {
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
    cancelPairing() {
        clearTimeout(this.pollTimer);
        this.pending = undefined;
        this.changed();
    }
    /**
     * POSTs to a device route with this browser's token (push subscription).
     *
     * @param path - The route.
     * @param body - The JSON body.
     * @returns The answer, or undefined when not paired or offline.
     */
    async postAsDevice(path, body) {
        return this.ident ? post(path, body, this.ident.token).catch(() => undefined) : undefined;
    }
    /** Forgets this browser's key, token, tasks and notifications (the hub page's "forget this browser"). */
    async forget() {
        await dropLocalPush();
        this.stop();
        this.ident = undefined;
        this.presence = [];
        this.tasks = [];
        this.agents.clear();
        this.agentSeq = 0;
        await put("device", undefined).catch(() => undefined);
        await put("tasks", undefined).catch(() => undefined);
        await put("pcKeys", undefined).catch(() => undefined);
        this.pcKeysText = "";
        this.changed();
    }
    // ---- the socket ----
    stop() {
        clearTimeout(this.retryTimer);
        clearInterval(this.pingTimer);
        this.syncPings.cancel();
        this.ws?.close();
        this.ws = undefined;
        this.connected = false;
    }
    /** Connects (a one-use ticket, then the socket); reconnects with backoff. */
    connect() {
        if (!this.ident || this.ws)
            return;
        void (async () => {
            const id = this.ident;
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
    later() {
        if (!this.ident)
            return;
        const base = Math.min(120_000, 1000 * 2 ** this.retry++);
        this.retryTimer = window.setTimeout(() => this.connect(), base / 2 + Math.random() * (base / 2));
    }
    sendFrame(frame) {
        if (this.ws?.readyState !== WebSocket.OPEN)
            return false;
        this.ws.send(JSON.stringify(frame));
        return true;
    }
    async onFrame(text) {
        let f;
        try {
            f = JSON.parse(text);
        }
        catch {
            return;
        }
        switch (f.t) {
            case "welcome":
                this.connected = true;
                this.paused = f.paused;
                this.presence = f.presence;
                void this.keepPcKeys();
                rememberDirect(f.presence);
                if (this.ident && f.hubKey && f.hubKey !== this.ident.hubKey) {
                    this.ident.hubKey = f.hubKey;
                    await put("device", this.ident).catch(() => undefined);
                }
                this.changed();
                void this.catchUpAgents();
                return this.flushOutbox();
            case "presence":
                this.presence = f.presence;
                void this.keepPcKeys();
                rememberDirect(f.presence);
                return this.changed();
            case "pause":
                this.paused = f.paused;
                return this.changed();
            case "sync":
                for (const cb of this.syncListeners)
                    cb();
                return;
            case "revoked":
                this.error = { he: "הדפדפן הזה נותק מהמרכז", en: "This browser was disconnected from the hub" };
                return this.forget();
            case "sent":
                return this.mark(f.id, (task) => {
                    task.status = f.queued ? "waiting" : task.route === "claude-cloud" ? "running" : "sent";
                    task.history.push(f.queued ? { t: Date.now(), he: "ממתין במרכז עד שהמחשב יידלק", en: "Waiting at the hub until the PC is on" } : { t: Date.now(), he: "נמסר", en: "Delivered" });
                });
            case "refused": {
                if (!f.id)
                    return;
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
    async mark(envId, change) {
        const task = this.tasks.find((t) => t.envId === envId);
        if (!task)
            return;
        change(task);
        await this.saveTasks();
    }
    /**
     * Fetches the agent activity kept for this browser since the last one it has (after a reconnect, like SSE's
     * `Last-Event-ID`), a page of 500 at a time.
     */
    async catchUpAgents() {
        const id = this.ident;
        if (!id || this.catchingUp)
            return;
        this.catchingUp = true;
        try {
            for (let page = 0; page < 10; page++) {
                const r = await fetch(`/api/agents?since=${this.agentSeq}`, { credentials: "same-origin", headers: { authorization: `Bearer ${id.token}` } }).catch(() => undefined);
                if (!r?.ok)
                    return;
                const data = (await r.json().catch(() => ({})));
                for (const env of Array.isArray(data.envs) ? data.envs : [])
                    await this.onAgentEvent(env, false);
                this.changed();
                if (!data.more)
                    return;
            }
        }
        finally {
            this.catchingUp = false;
        }
    }
    /** One sealed activity batch (live or caught up): opened with its PC's key and applied to its card. */
    async onAgentEvent(env, live) {
        const id = this.ident;
        const senderKey = this.presence.find((d) => d.id === env.from)?.publicKey;
        if (!id || !senderKey)
            return;
        let body;
        try {
            body = await openEnvelope(env, id.privateKey, senderKey);
        }
        catch {
            return; // Tampered or not for us: ignored (activity is never acked; the hub keeps only a short ring).
        }
        if (body.type !== "agent_event" || body.runId !== env.run)
            return;
        const seq = typeof env.seq === "number" ? env.seq : 0;
        this.agentSeq = Math.max(this.agentSeq, seq);
        const card = applyAgentBatch(this.agents, env.from, body, typeof env.at === "number" ? env.at : Date.now(), seq);
        // A new state answers a pending Stop or Approve: the card shows the PC's word again.
        if (body.events.length)
            this.agentActions.delete(`${card.deviceId}/${card.runId}`);
        const sent = this.agentLabels.get(`${card.deviceId}/${card.runId}`);
        if (sent?.savedAt && sameLabel(card.state, sent.label))
            this.agentLabels.delete(`${card.deviceId}/${card.runId}`);
        if (live)
            this.changed();
    }
    /**
     * Stops an agent run on its PC (a sealed `cancel`; the PC stops it like its own Stop button).
     *
     * @param c - The card.
     * @returns Whether it was sent.
     */
    async stopAgent(c) {
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
    async answerAgent(c, decision) {
        const w = c.state.waiting;
        if (!w)
            return false;
        return this.sendToAgent(c, "approval_answer", { type: "approval_answer", requestId: w.requestId, conversationId: w.conversationId, decision }, decision);
    }
    /**
     * Renames a run and sets its note on its PC: a sealed `agent-label` command, which the PC takes only from the
     * owner's paired phone or hub page; the PC keeps it and sends the run's state again.
     *
     * @param c - The card.
     * @param label - The new name and note (empty fields clear them).
     * @returns Whether it was sent.
     */
    async labelAgent(c, label) {
        const id = this.ident;
        const pc = this.presence.find((d) => d.id === c.deviceId);
        if (!id || !pc?.online || !this.connected)
            return false;
        const commandId = randomB64url(12);
        const clean = { ...(label.name?.trim() ? { name: label.name.trim() } : {}), ...(label.note?.trim() ? { note: label.note.trim() } : {}) };
        const env = await sealMessage({ from: id.deviceId, to: pc.id, kind: "command" }, { type: "command", commandId, action: "agent-label", taskId: c.runId, label: clean }, id.privateKey, pc.publicKey);
        if (!this.sendFrame({ t: "send", env }))
            return false;
        this.agentLabels.set(`${c.deviceId}/${c.runId}`, { commandId, label: clean });
        this.changed();
        return true;
    }
    /**
     * The name and note to show for a run: one sent from here and not yet answered or just saved, else the PC's.
     *
     * @param c - The card.
     * @returns The label, and whether it waits for the PC or the PC refused it.
     */
    shownLabel(c) {
        const sent = this.agentLabels.get(`${c.deviceId}/${c.runId}`);
        const pc = { ...(c.state.name ? { name: c.state.name } : {}), ...(c.state.note ? { note: c.state.note } : {}) };
        if (!sent)
            return { label: pc };
        if (sent.error)
            return { label: pc, error: sent.error };
        if (sent.savedAt && Date.now() - sent.savedAt > 15_000)
            return { label: pc };
        return { label: sent.label, pending: !sent.savedAt };
    }
    async sendToAgent(c, kind, body, action) {
        const id = this.ident;
        const pc = this.presence.find((d) => d.id === c.deviceId);
        if (!id || !pc?.online || !this.connected)
            return false;
        const env = await sealMessage({ from: id.deviceId, to: pc.id, kind }, body, id.privateKey, pc.publicKey);
        if (!this.sendFrame({ t: "send", env }))
            return false;
        this.agentActions.set(`${c.deviceId}/${c.runId}`, action);
        this.changed();
        return true;
    }
    /**
     * The backup relays' keys from a paired PC (sealed to this browser, so the hub never saw them): kept in this
     * browser's IndexedDB (kv `relays`), the newest wins; empty keys forget them. Only a PC may send them.
     *
     * @param from - The PC (its envelope opened with its key).
     * @param keys - The checked keys.
     * @param at - When the PC sent them (ms).
     */
    async onRelayKeys(from, keys, at) {
        if (this.presence.find((d) => d.id === from)?.kind !== "pc")
            return;
        const old = await get("relays").catch(() => undefined);
        if (old && old.at > at)
            return;
        await put("relays", { from, keys, at }).catch(() => undefined);
        this.changed();
    }
    /**
     * Keeps the paired PCs' public keys and names for the service worker (kv `pcKeys`), so a notification's ask can be
     * opened and answered with the page closed. The same keys the page itself uses from presence; written only on change.
     */
    async keepPcKeys() {
        const keys = Object.fromEntries(this.presence.filter((d) => d.kind === "pc").map((d) => [d.id, { publicKey: d.publicKey, name: d.name }]));
        const text = JSON.stringify(keys);
        if (text === this.pcKeysText)
            return;
        this.pcKeysText = text;
        await put("pcKeys", keys).catch(() => undefined);
    }
    /** A sealed message for this browser: a PC's progress or result, or the hub's "Claude cloud started". */
    async onDeliver(env) {
        const id = this.ident;
        if (!id)
            return;
        if (env.kind === "agent_event")
            return this.onAgentEvent(env, true);
        const senderKey = env.from === "hub" ? id.hubKey : this.presence.find((d) => d.id === env.from)?.publicKey;
        if (!senderKey)
            return; // A sender not in presence (yet): it comes again on the next connect.
        let body;
        try {
            body = await openEnvelope(env, id.privateKey, senderKey);
        }
        catch {
            return void this.sendFrame({ t: "ack", id: env.id }); // Tampered or not for us: drop it.
        }
        this.sendFrame({ t: "ack", id: env.id });
        // A PC before the approvals snapshot sent single requests: the snapshot replaced them, so they are dropped.
        if (body.type === "approval_request")
            return;
        if (!this.replay.first(env.id, env.ttl))
            return;
        if (body.type === "approvals")
            return this.onApprovals(env.from, body.items, body.at);
        if (body.type === "board")
            return this.onBoard(env.from, body.items, body.doneTotal, body.rev, body.at);
        if (body.type === "command_result")
            return this.onCommandResult(body.commandId, body.taskId, body.ok, body.text, body.ask);
        if (body.type === "inbox_task")
            return this.onInboxTask(env.from, body);
        if (body.type === "relays")
            return this.onRelayKeys(env.from, body.keys, body.at);
        const task = "taskId" in body ? this.tasks.find((t) => t.taskId === body.taskId && !t.inbox) : undefined;
        if (!task)
            return;
        const now = Date.now();
        if (body.type === "progress") {
            task.status = "running";
            task.line = body.line;
        }
        else if (body.type === "result") {
            task.status = body.status;
            task.line = body.text;
            if (body.link)
                task.link = body.link;
            if (body.branch)
                task.branch = body.branch;
            task.history.push({ t: now, he: { done: "הסתיים", failed: "נכשל", blocked: "נתקע", cancelled: "בוטל" }[body.status], en: { done: "Done", failed: "Failed", blocked: "Blocked", cancelled: "Cancelled" }[body.status] });
        }
        else if (body.type === "cloud_started") {
            if (body.error) {
                task.status = "failed";
                task.line = body.error;
                task.history.push({ t: now, he: "Claude בענן לא התחיל", en: "Claude cloud did not start" });
            }
            else {
                task.status = "running";
                if (body.sessionUrl)
                    task.link = body.sessionUrl;
                task.history.push({ t: now, he: "התחיל ב-Claude בענן", en: "Started in Claude cloud" });
            }
        }
        await this.saveTasks();
    }
    /** A PC's board snapshot: replaces the last one (an older one that arrives late is ignored). */
    onBoard(from, items, doneTotal, rev, at) {
        const last = this.boards.get(from);
        if (last && last.at > at)
            return;
        this.boards.set(from, { items, doneTotal, rev, at });
        this.changed();
    }
    /**
     * Reopen, a higher priority, "for self-work" or a note on a board task: a sealed `command` to that PC, which applies
     * it through the board's own rules as it does for the same buttons on its screen.
     *
     * @param pc - The PC whose board it is (on).
     * @param taskId - The board task's id.
     * @param board - What to do.
     * @returns Whether it was sent.
     */
    async boardCommand(pc, taskId, board) {
        const id = this.ident;
        if (!id || !this.connected || !pc.online)
            return false;
        const commandId = randomB64url(12);
        const env = await sealMessage({ from: id.deviceId, to: pc.id, kind: "command" }, { type: "command", commandId, action: "board", taskId, board }, id.privateKey, pc.publicKey);
        if (!this.sendFrame({ t: "send", env }))
            return false;
        this.boardActions.set(`${pc.id}/${taskId}`, { commandId });
        this.changed();
        return true;
    }
    /** A PC's approvals snapshot: replaces the last one (an older one that arrives late is ignored). */
    onApprovals(from, items, at) {
        const last = this.approvals.get(from);
        if (last && last.at > at)
            return;
        this.approvals.set(from, { items, at });
        // An answer sent from here is settled once its request has left the PC's list.
        for (const key of [...this.approvalActions.keys()])
            if (key.startsWith(`${from}/`) && !items.some((a) => `${from}/${a.requestId}` === key))
                this.approvalActions.delete(key);
        this.changed();
    }
    /**
     * Whether a task waits for the owner's Run on a PC (an Antigravity task of a PC's inbox, or one in Google Drive that a
     * PC will queue), and a PC that could take the press is on.
     *
     * @param t - The task.
     * @returns True when Run / Cancel can be offered.
     */
    canRun(t) {
        const waits = t.inbox ? t.status === "waiting-run" : !!t.drive?.only && t.executor === "pc-antigravity" && t.status === "waiting";
        return waits && this.connected && this.commandTargets(t).length > 0;
    }
    /**
     * Whether a task's Run was just tapped and the PC has not reported it yet: its card shows "Starting…" (no Run, so
     * it cannot be sent twice) until the task is running, queued or failed, the PC refuses it, or 60 s pass.
     *
     * @param t - The task.
     * @returns True while "Starting…" is shown.
     */
    runStarting(t) {
        const a = this.taskActions.get(t.taskId);
        return !!a && a.action === "inbox-run" && runStarting(a.at, this.canRun(t), Date.now(), a.result?.ok === false, a.result?.ok === true);
    }
    /** The PCs that are on (a work-list item is sent to one of them). */
    onlinePcs() {
        return this.presence.filter((d) => d.kind === "pc" && d.online);
    }
    /**
     * The PCs a task's "Who does it" goes to: its inbox's PC, or (a Drive task) every PC that is on.
     *
     * @param t - The task.
     * @returns The PCs.
     */
    assignTargets(t) {
        return this.commandTargets(t);
    }
    /**
     * "Who does it": a sealed `assign` command to the PCs (each checks it came from the owner's paired phone or hub
     * page). Only the PC that has the task acts; the others answer no.
     *
     * @param taskId - The inbox task id, its Drive record id, or a work-list item's record id.
     * @param pcs - The PCs to send it to.
     * @param to - Who does it now.
     * @param confirm - The user's yes to the PC's question (stop a running task, run a finished one again).
     * @param model - Only picks the model of an Antigravity task (a name the PC sent, "" = the default for its kind).
     * @returns Whether it was sent.
     */
    async assign(taskId, pcs, to, confirm = false, model) {
        const id = this.ident;
        if (!id || !this.connected || !pcs.length)
            return false;
        const commandId = randomB64url(12);
        let sent = 0;
        for (const pc of pcs) {
            const env = await sealMessage({ from: id.deviceId, to: pc.id, kind: "command" }, { type: "command", commandId, action: "assign", taskId, to, ...(confirm ? { confirm: true } : {}), ...(model !== undefined ? { model } : {}) }, id.privateKey, pc.publicKey);
            if (this.sendFrame({ t: "send", env }))
                sent++;
        }
        if (sent)
            this.assignActions.set(taskId, { commandId, to, pcs: pcs.map((p) => p.id), left: sent });
        this.changed();
        return sent > 0;
    }
    /** The PCs a command for a task goes to: its inbox's PC, or (a Drive task) every PC that is on. */
    commandTargets(t) {
        return this.presence.filter((d) => d.kind === "pc" && d.online && (!t.inbox || d.id === t.inbox.deviceId));
    }
    /**
     * Run or Cancel for a task that waits for Run: a sealed `command` to its PC (a Drive task: to each PC that is on;
     * only the one that queued it acts). The PC checks it came from the owner's paired phone or hub page, then runs it
     * as its own Run button does (one press, one run) or skips it.
     *
     * @param t - The task.
     * @param action - Run or Cancel.
     * @returns Whether it was sent.
     */
    async inboxCommand(t, action) {
        const id = this.ident;
        const to = this.commandTargets(t);
        if (!id || !this.connected || !to.length)
            return false;
        const commandId = randomB64url(12);
        let sent = 0;
        for (const pc of to) {
            const env = await sealMessage({ from: id.deviceId, to: pc.id, kind: "command" }, { type: "command", commandId, action, taskId: t.taskId }, id.privateKey, pc.publicKey);
            if (this.sendFrame({ t: "send", env }))
                sent++;
        }
        if (sent) {
            this.taskActions.set(t.taskId, { action, commandId, left: sent, at: Date.now() });
            // "Starting…" ends by itself after RUN_STARTING_MS even when no report comes: draw the card again then.
            if (action === "inbox-run")
                setTimeout(() => this.changed(), RUN_STARTING_MS + 200);
        }
        this.changed();
        return sent > 0;
    }
    /**
     * A PC's answer to Run / Cancel, shown on the task. A Drive task's command went to every PC that is on: the one that
     * acted answers yes; a "no" is shown only when every PC said no (the last one's words).
     */
    onCommandResult(commandId, taskId, ok, text, ask) {
        for (const sent of this.boardActions.values()) {
            if (sent.commandId !== commandId)
                continue;
            sent.result = { ok, text, at: Date.now() };
            return this.changed();
        }
        const as = this.assignActions.get(taskId);
        if (as && as.commandId === commandId && !as.result?.ok && !as.result?.ask) {
            as.left--;
            // Sent to several PCs: a "no" shows only when every PC said no; the one that has it answers yes or asks.
            if (!ok && !ask && as.left > 0)
                return;
            as.result = { ok, text, ...(ask ? { ask } : {}) };
            return this.changed();
        }
        for (const sent of this.agentLabels.values()) {
            if (sent.commandId !== commandId)
                continue;
            if (ok)
                sent.savedAt = Date.now();
            else
                sent.error = text || "It did not work.";
            return this.changed();
        }
        const a = this.taskActions.get(taskId);
        if (!a || a.commandId !== commandId || a.result?.ok)
            return;
        a.left--;
        if (!ok && a.left > 0)
            return;
        a.result = { ok, text };
        this.changed();
    }
    /**
     * Everything waiting for the owner now, on the PCs that are on: their approvals (newest first), with the PC.
     *
     * @returns The approvals and their PCs.
     */
    waiting() {
        const out = [];
        for (const [id, snap] of this.approvals) {
            const pc = this.presence.find((d) => d.id === id && d.kind === "pc" && d.online);
            if (!pc)
                continue;
            for (const item of snap.items) {
                const sent = this.approvalActions.get(`${id}/${item.requestId}`);
                out.push({ pc, item, ...(sent ? { sent } : {}) });
            }
        }
        return out.sort((a, b) => b.item.at - a.item.at);
    }
    /**
     * Answers an approval waiting on a PC: a sealed `approval_answer` to that PC, which applies it as its own card does
     * (the PC takes answers only from the owner's paired phones and hub pages).
     *
     * @param pcId - The PC.
     * @param a - The approval.
     * @param decision - Allow or deny.
     * @param forMinutes - "Allow for a while", in minutes (allow only).
     * @returns Whether it was sent.
     */
    async answerApproval(pcId, a, decision, forMinutes) {
        const id = this.ident;
        const pc = this.presence.find((d) => d.id === pcId && d.kind === "pc");
        if (!id || !pc?.online || !this.connected)
            return false;
        const mins = decision === "allow" && a.forWhile && forMinutes ? Math.min(forMinutes, HUB_LIMITS.approvalForMaxMin) : 0;
        const env = await sealMessage({ from: id.deviceId, to: pc.id, kind: "approval_answer" }, { type: "approval_answer", requestId: a.requestId, conversationId: a.conversationId, decision, ...(mins ? { forMinutes: mins } : {}) }, id.privateKey, pc.publicKey);
        if (!this.sendFrame({ t: "send", env }))
            return false;
        this.approvalActions.set(`${pc.id}/${a.requestId}`, mins ? "while" : decision);
        this.changed();
        return true;
    }
    /**
     * A PC's report of one of its task-inbox tasks: added to the task list, or its state, branch and result updated.
     * Reports can arrive out of order from the hub's queue, so an older one never overwrites a newer one.
     */
    async onInboxTask(from, r) {
        const pc = this.presence.find((d) => d.id === from);
        const status = r.state;
        let task = this.tasks.find((t) => t.inbox?.deviceId === from && t.taskId === r.taskId);
        const label = INBOX_LABEL[r.state];
        if (!task) {
            task = { taskId: r.taskId, title: r.title, spec: "", executor: r.executor === "claude" ? "claude-cloud" : r.executor === "local" || r.executor === "gemini" ? "pc-local" : "pc-antigravity", ifOffline: "wait", route: r.executor === "claude" ? "claude-cloud" : "pc", to: from, toName: pc?.name ?? "PC", createdAt: r.at || Date.now(), status, history: [] };
            this.tasks.unshift(task);
        }
        else if (task.inbox && task.inbox.at > r.at) {
            return;
        }
        // The PC's report replaces its earlier "Started on the PC." answer: the card follows the report from here on.
        const sent = this.taskActions.get(r.taskId);
        if (sent?.action === "inbox-run" && sent.result?.ok)
            this.taskActions.delete(r.taskId);
        task.title = r.title;
        task.status = status;
        task.inbox = inboxMetaOf(r, from);
        if (r.result)
            task.line = r.result;
        else
            delete task.line;
        if (r.branch)
            task.branch = r.branch;
        if (pc)
            task.toName = pc.name;
        if (task.history.at(-1)?.en !== label.en)
            task.history.push({ t: r.at || Date.now(), ...label });
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
    route(executor, ifOffline, cloudAvailable) {
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
    async send(text, executor, ifOffline, cloudAvailable) {
        const spec = text.trim().slice(0, HUB_LIMITS.specChars);
        if (!spec)
            return { error: { he: "כתוב מה לעשות", en: "Write what to do" } };
        const r = this.route(executor, ifOffline, cloudAvailable);
        if (r.route === "none" || !r.to)
            return { error: r.reason };
        const toName = r.to === "hub" ? "Claude cloud" : (this.presence.find((d) => d.id === r.to)?.name ?? "PC");
        const task = { taskId: randomB64url(12), title: spec.split("\n")[0].slice(0, 120), spec, executor, ifOffline, route: r.route, to: r.to, toName, createdAt: Date.now(), status: "outbox", history: [{ t: Date.now(), he: `נוצר · נותב: ${r.reason.he}`, en: `Created · routed: ${r.reason.en}` }] };
        this.tasks.unshift(task);
        await this.saveTasks();
        await this.deliver(task);
        return task;
    }
    /** Seals and sends one task (or leaves it in the outbox while offline). */
    async deliver(task) {
        const id = this.ident;
        if (!id || !this.connected || !task.to)
            return;
        const recipient = task.to === "hub" ? id.hubKey : this.presence.find((d) => d.id === task.to)?.publicKey;
        if (!recipient) {
            task.status = "failed";
            task.line = REFUSAL["no-recipient"][document.documentElement.lang === "en" ? "en" : "he"];
            return this.saveTasks();
        }
        const env = await sealMessage({ from: id.deviceId, to: task.to, kind: task.route === "claude-cloud" ? "cloud" : "task" }, { type: "task", taskId: task.taskId, title: task.title, spec: task.spec, executor: task.executor, ifOffline: task.ifOffline, createdAt: new Date(task.createdAt).toISOString() }, id.privateKey, recipient);
        task.envId = env.id;
        if (this.sendFrame({ t: "send", env }))
            await this.saveTasks();
    }
    /** Sends what waited for a connection. */
    async flushOutbox() {
        for (const t of this.tasks.filter((x) => x.status === "outbox"))
            await this.deliver(t);
    }
    /**
     * Sends a task again (after it failed or expired), routed again from now.
     *
     * @param task - The old task.
     * @param cloudAvailable - Whether the Claude cloud path is available.
     * @param executor - Another executor (e.g. "claude-cloud" for "send to the cloud instead").
     * @returns The new task or an error.
     */
    resend(task, cloudAvailable, executor = task.executor) {
        return this.send(task.spec, executor, task.ifOffline, cloudAvailable);
    }
    /**
     * Removes a task from this browser (an outbox one is never sent).
     *
     * @param taskId - The task.
     */
    async remove(taskId) {
        this.tasks = this.tasks.filter((t) => t.taskId !== taskId);
        await this.saveTasks();
    }
    /**
     * Whether a waiting task is past what the hub keeps (24 hours), so it is shown as expired.
     *
     * @param t - The task.
     * @returns True when expired.
     */
    static expired(t) {
        return !t.inbox && !t.drive?.only && (t.status === "waiting" || t.status === "outbox") && Date.now() - t.createdAt > HUB_LIMITS.defaultTtl * 1000;
    }
}
