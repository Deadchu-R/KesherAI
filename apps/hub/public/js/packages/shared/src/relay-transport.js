/**
 * Backup relays beside the Kesher Cloud hub (Roee 2026-11-22, "three relays"): Ably and Supabase Realtime carry the
 * same sealed envelopes the hub does, so a limit or an outage at one provider never stops KesherAI.
 *
 * Both adapters speak the providers' plain protocols with `fetch` and a WebSocket (no SDK, no new dependency), so the
 * same code runs on the PC (Node 22) and in the hub page on the phone:
 * - Ably: subscribe over the realtime WebSocket (`wss://realtime.ably.io`, JSON protocol messages: CONNECTED 4,
 *   ATTACH 10, ATTACHED 11, MESSAGE 15, HEARTBEAT 0, ERROR 9); publish with the REST API
 *   (`POST https://rest.ably.io/channels/<name>/messages`, Basic auth with the API key).
 * - Supabase Realtime broadcast: subscribe over the Phoenix-channels WebSocket (`/realtime/v1/websocket`, protocol
 *   1.0.0 JSON objects: `phx_join`, a `phoenix` heartbeat every 25 s, `broadcast` events); publish with the REST
 *   broadcast endpoint (`POST /realtime/v1/api/broadcast`).
 *
 * Security: only {@link SealedEnvelope}s go through (AES-GCM sealed end to end, the providers see ciphertext); each
 * pair's channel name is derived from the pair's ECDH shared secret with HKDF ({@link pairChannel}), so it shows no
 * device id and nobody without one of the two private keys can find or guess it. Every envelope that comes in is
 * checked with `parseEnvelope` and opened (and deduplicated by id) by the caller, exactly like one from the hub. The
 * keys are never logged and never put into an error text.
 */
import { importPublicKey } from "./hub-crypto.js";
import { parseEnvelope } from "./hub-protocol.js";
export * from "./relay-keys.js";
const enc = new TextEncoder();
/**
 * The channel name of one pair of devices on the backup relays: HKDF-SHA-256 over their ECDH shared secret, so both
 * sides get the same name from their own private key and the other's public key, and it shows no device id.
 *
 * @param ownPrivate - This device's private key.
 * @param otherPublic - The other device's public key (raw base64url).
 * @returns `kesher-` and 32 hex characters (valid on Ably and Supabase).
 */
export async function pairChannel(ownPrivate, otherPublic) {
    const subtle = globalThis.crypto.subtle;
    const shared = await subtle.deriveBits({ name: "ECDH", public: await importPublicKey(otherPublic) }, ownPrivate, 256);
    const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    const bits = new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("kesher-relay"), info: enc.encode("kesher-relay channel v1") }, base, 128));
    return `kesher-${Array.from(bits, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
/** The longest wait between reconnects, and after a refused key (it will not work until Roee changes it). */
const MAX_BACKOFF_MS = 120_000;
const AUTH_BACKOFF_MS = 30 * 60_000;
/** How long a REST publish may take. */
const PUBLISH_TIMEOUT_MS = 10_000;
/**
 * What both adapters share: the channel set, the listeners, health, reconnect with backoff and a silence watchdog.
 * A subclass builds the socket URL and speaks its provider's frames.
 */
class BaseTransport {
    deps;
    ws;
    channels = new Set();
    state = "off";
    okAt;
    error;
    publishFailing = false;
    listeners = new Set();
    retry = 0;
    retryTimer;
    watchTimer;
    closed = true;
    /** Bumped on every new socket, so the events of an old one are ignored. */
    gen = 0;
    now;
    setTimer;
    clearTimer;
    constructor(deps) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
        this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
    }
    connect() {
        this.closed = false;
        if (this.ws || !this.channels.size)
            return;
        this.clearTimer(this.retryTimer);
        this.retryTimer = undefined;
        const gen = ++this.gen;
        this.state = "connecting";
        let ws;
        try {
            ws = this.deps.openSocket(this.socketUrl());
        }
        catch {
            this.lost("socket open failed");
            return;
        }
        this.ws = ws;
        ws.onopen = () => {
            if (gen !== this.gen)
                return;
            this.heard();
            this.onOpen();
        };
        ws.onmessage = (ev) => {
            if (gen !== this.gen)
                return;
            this.heard();
            let f;
            try {
                f = JSON.parse(String(ev.data));
            }
            catch {
                return;
            }
            if (f && typeof f === "object")
                this.onFrame(f);
        };
        ws.onerror = () => undefined;
        ws.onclose = () => {
            if (gen !== this.gen)
                return;
            this.lost(this.error ?? "socket closed");
        };
    }
    setChannels(names) {
        const next = new Set(names);
        const open = this.state === "open";
        for (const c of this.channels)
            if (!next.has(c) && open)
                this.leave(c);
        for (const c of next)
            if (!this.channels.has(c) && open)
                this.join(c);
        this.channels = next;
        if (!this.closed && !this.ws && next.size && this.retryTimer === undefined)
            this.connect();
        if (!next.size && this.ws)
            this.drop();
    }
    async publish(channel, env) {
        const { url, init } = this.publishRequest(channel, env);
        try {
            const r = await this.deps.fetch(url, { ...init, signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS) });
            if (r.ok) {
                this.publishFailing = false;
                this.okAt = this.now();
                return true;
            }
            this.publishFailing = true;
            this.error = `publish ${r.status}`;
            return false;
        }
        catch {
            this.publishFailing = true;
            this.error = "publish unreachable";
            return false;
        }
    }
    onEnvelope(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
    close() {
        this.closed = true;
        this.clearTimer(this.retryTimer);
        this.retryTimer = undefined;
        this.drop();
        this.state = "off";
    }
    health() {
        return { state: this.state, healthy: this.state === "open" && !this.publishFailing, ...(this.okAt ? { okAt: this.okAt } : {}), ...(this.error ? { error: this.error } : {}) };
    }
    /** The link is up and subscribed. */
    opened() {
        this.state = "open";
        this.retry = 0;
        this.error = undefined;
        this.okAt = this.now();
    }
    /** Passes one incoming envelope (checked) to the listeners. */
    deliver(raw, channel) {
        if (!this.channels.has(channel))
            return;
        const env = parseEnvelope(raw);
        if (!env)
            return;
        this.okAt = this.now();
        for (const cb of this.listeners)
            cb(env, channel);
    }
    /** Sends one frame on the open socket. */
    sendFrame(f) {
        try {
            if (this.ws?.readyState === 1)
                this.ws.send(JSON.stringify(f));
        }
        catch {
            // Closing: the reconnect joins again.
        }
    }
    /**
     * The link failed: drop it and try again later.
     *
     * @param why - Short English, no key.
     * @param auth - The provider refused the key: wait long (it fails until the key changes).
     */
    lost(why, auth = false) {
        this.error = why;
        this.drop();
        if (this.closed) {
            this.state = "off";
            return;
        }
        this.state = "down";
        const base = auth ? AUTH_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.retry++);
        this.clearTimer(this.retryTimer);
        this.retryTimer = this.setTimer(() => {
            this.retryTimer = undefined;
            this.connect();
        }, auth ? base : base / 2 + Math.random() * (base / 2));
    }
    /** Something came on the link: the silence watchdog starts again. */
    heard() {
        this.clearTimer(this.watchTimer);
        this.watchTimer = this.setTimer(() => this.lost("no heartbeat"), this.silenceMs());
    }
    /** Closes the socket without reconnecting by itself (the caller decides). */
    drop() {
        this.gen++;
        this.clearTimer(this.watchTimer);
        this.watchTimer = undefined;
        const ws = this.ws;
        this.ws = undefined;
        if (this.state === "open" || this.state === "connecting")
            this.state = "down";
        try {
            ws?.close();
        }
        catch {
            // Already closed.
        }
    }
}
/** Ably's protocol message actions this adapter uses. */
/**
 * The client ID every KesherAI device claims on Ably (allowed with an API key). Some apps or namespaces refuse
 * anonymous clients (error 40161, identified_client_required); a fixed, non-personal ID satisfies them. Devices are
 * told apart by the sealed envelopes, never by this.
 */
export const ABLY_CLIENT_ID = "kesher";
const ABLY = { HEARTBEAT: 0, CONNECTED: 4, DISCONNECTED: 6, CLOSED: 8, ERROR: 9, ATTACH: 10, ATTACHED: 11, DETACH: 12, DETACHED: 13, MESSAGE: 15 };
/**
 * Ably: the realtime WebSocket for listening (JSON protocol, server heartbeats as protocol messages), the REST API for
 * publishing. The free plan: 6M messages a month, 200 connections, no card.
 */
export class AblyTransport extends BaseTransport {
    key;
    kind = "ably";
    idleMs = 15_000;
    /**
     * @param key - The Ably API key (checked with {@link cleanAblyKey}).
     * @param deps - Network and clock.
     */
    constructor(key, deps) {
        super(deps);
        this.key = key;
    }
    socketUrl() {
        return `wss://realtime.ably.io/?key=${encodeURIComponent(this.key)}&clientId=${ABLY_CLIENT_ID}&format=json&heartbeats=true&echo=false`;
    }
    onOpen() {
        // Wait for CONNECTED before attaching.
    }
    silenceMs() {
        return this.idleMs + 15_000;
    }
    join(channel) {
        this.sendFrame({ action: ABLY.ATTACH, channel });
    }
    leave(channel) {
        this.sendFrame({ action: ABLY.DETACH, channel });
    }
    onFrame(f) {
        switch (f.action) {
            case ABLY.CONNECTED: {
                const d = f.connectionDetails;
                if (typeof d?.maxIdleInterval === "number" && d.maxIdleInterval > 0)
                    this.idleMs = Math.min(120_000, d.maxIdleInterval);
                this.opened();
                for (const c of this.channels)
                    this.join(c);
                return;
            }
            case ABLY.MESSAGE: {
                const channel = typeof f.channel === "string" ? f.channel : "";
                for (const m of Array.isArray(f.messages) ? f.messages : []) {
                    if (m?.name !== "env" || typeof m.data !== "string")
                        continue;
                    if (m.encoding && m.encoding !== "json" && m.encoding !== "utf-8")
                        continue;
                    try {
                        this.deliver(JSON.parse(m.data), channel);
                    }
                    catch {
                        // Not JSON: not ours.
                    }
                }
                return;
            }
            case ABLY.ERROR: {
                const e = f.error;
                const code = typeof e?.code === "number" ? e.code : 0;
                // A channel error leaves the link up; a connection error ends it (401xx: the key was refused).
                if (typeof f.channel === "string")
                    this.error = `channel error ${code}`;
                else
                    this.lost(`error ${code}`, e?.statusCode === 401 || (code >= 40100 && code < 40200));
                return;
            }
            case ABLY.DISCONNECTED:
            case ABLY.CLOSED:
                return this.lost("disconnected");
            default:
                return;
        }
    }
    publishRequest(channel, env) {
        return {
            url: `https://rest.ably.io/channels/${encodeURIComponent(channel)}/messages`,
            init: { method: "POST", headers: { authorization: `Basic ${btoa(this.key)}`, "content-type": "application/json" }, body: JSON.stringify({ name: "env", clientId: ABLY_CLIENT_ID, data: JSON.stringify(env) }) },
        };
    }
}
/** Supabase's heartbeat interval (the server drops a socket silent for longer than about 30 s). */
const SUPABASE_BEAT_MS = 25_000;
/**
 * Supabase Realtime broadcast: the Phoenix-channels WebSocket (protocol 1.0.0) for listening on public broadcast
 * channels, the REST broadcast endpoint for publishing. The free plan: 2M messages a month, 200 connections.
 */
export class SupabaseTransport extends BaseTransport {
    cfg;
    kind = "supabase";
    ref = 0;
    beatTimer;
    /** The ref of the heartbeat not answered yet (a second one unanswered ends the link). */
    beatRef;
    /** Join refs by channel, and the channels the server confirmed. */
    joins = new Map();
    /**
     * @param cfg - The project URL and anon key (checked with {@link cleanSupabaseUrl} / {@link cleanSupabaseKey}).
     * @param deps - Network and clock.
     */
    constructor(cfg, deps) {
        super(deps);
        this.cfg = cfg;
    }
    nextRef() {
        return String(++this.ref);
    }
    socketUrl() {
        return `${this.cfg.url.replace(/^https:/, "wss:")}/realtime/v1/websocket?apikey=${encodeURIComponent(this.cfg.anonKey)}&vsn=1.0.0`;
    }
    silenceMs() {
        return SUPABASE_BEAT_MS * 2 + 10_000;
    }
    onOpen() {
        this.joins.clear();
        this.opened();
        for (const c of this.channels)
            this.join(c);
        this.beat();
    }
    /** Sends the heartbeat every 25 s; a heartbeat still unanswered at the next one ends the link. */
    beat() {
        if (this.state !== "open")
            return;
        if (this.beatRef)
            return this.lost("no heartbeat reply");
        this.beatRef = this.nextRef();
        this.sendFrame({ topic: "phoenix", event: "heartbeat", payload: {}, ref: this.beatRef });
        this.beatTimer = this.setTimer(() => this.beat(), SUPABASE_BEAT_MS);
    }
    join(channel) {
        const ref = this.nextRef();
        this.joins.set(channel, ref);
        this.sendFrame({ topic: `realtime:${channel}`, event: "phx_join", payload: { config: { broadcast: { self: false, ack: false }, presence: { key: "" }, private: false } }, ref, join_ref: ref });
    }
    leave(channel) {
        this.sendFrame({ topic: `realtime:${channel}`, event: "phx_leave", payload: {}, ref: this.nextRef(), join_ref: this.joins.get(channel) ?? null });
        this.joins.delete(channel);
    }
    onFrame(f) {
        const topic = typeof f.topic === "string" ? f.topic : "";
        const payload = f.payload && typeof f.payload === "object" ? f.payload : {};
        if (f.event === "phx_reply") {
            if (topic === "phoenix" && f.ref === this.beatRef)
                this.beatRef = undefined;
            // A refused join (public channels turned off in the project): it fails until the setting changes.
            else if (payload.status === "error" && topic.startsWith("realtime:"))
                this.lost("join refused", true);
            return;
        }
        if (f.event === "broadcast" && topic.startsWith("realtime:") && payload.event === "env") {
            const inner = payload.payload;
            this.deliver(inner?.env, topic.slice("realtime:".length));
            return;
        }
        if ((f.event === "phx_error" || f.event === "phx_close") && topic.startsWith("realtime:")) {
            // The server dropped one channel: the simplest sure way back is a new link (all channels join again).
            this.lost("channel closed");
        }
    }
    publishRequest(channel, env) {
        // A JWT anon key also goes as the bearer token; a publishable key goes in `apikey` only.
        const jwt = this.cfg.anonKey.split(".").length === 3;
        return {
            url: `${this.cfg.url}/realtime/v1/api/broadcast`,
            init: {
                method: "POST",
                headers: { apikey: this.cfg.anonKey, ...(jwt ? { authorization: `Bearer ${this.cfg.anonKey}` } : {}), "content-type": "application/json" },
                body: JSON.stringify({ messages: [{ topic: channel, event: "env", payload: { env }, private: false }] }),
            },
        };
    }
    /** Closes the link and stops the heartbeat. */
    close() {
        this.stopBeat();
        super.close();
    }
    lost(why, auth = false) {
        this.stopBeat();
        super.lost(why, auth);
    }
    stopBeat() {
        if (this.beatTimer !== undefined)
            this.clearTimer(this.beatTimer);
        this.beatTimer = undefined;
        this.beatRef = undefined;
    }
}
/**
 * Makes the transports for the configured backup relays, in failover order.
 *
 * @param keys - The relay keys.
 * @param deps - Network and clock.
 * @returns One transport per configured relay.
 */
export function makeTransports(keys, deps) {
    const out = [];
    if (keys.ably)
        out.push(new AblyTransport(keys.ably.key, deps));
    if (keys.supabase)
        out.push(new SupabaseTransport(keys.supabase, deps));
    return out;
}
