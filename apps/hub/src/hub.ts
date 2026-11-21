/**
 * The hub's logic as a plain class: sign-in, sessions, pairing, tickets, token rotation, revocation, presence, the
 * sealed relay and the Claude cloud path. The Durable Object (`hub-do.ts`) only turns HTTP and socket events into
 * calls here, so everything below is tested without a network or the Workers runtime.
 *
 * What it keeps: device rows (name, public key, token hash, last seen, reported state), sessions and pairings as hashes,
 * sealed messages until their ack, settings, and a metadata-only audit trail (docs/RESEARCH_LOG.md, "Kesher Cloud hub").
 */
import {
  DEFAULT_OPT_IN,
  cleanDeviceKind,
  exportPrivateJwk,
  generateHubKeys,
  HUB_LIMITS,
  importPrivateJwk,
  importPublicKey,
  keyFingerprint,
  openEnvelope,
  parseDeviceFrame,
  parseEnvelope,
  randomB64url,
  sealMessage,
  sha256Hex,
  type HubCryptoKey,
  type HubDeviceKind,
  type HubFrame,
  type HubPresence,
  type HubRefusal,
  type SealedEnvelope,
} from "../../../packages/shared/src/hub.js";
import { claudeTrigger, fireText, type ClaudeTrigger, type FireResult } from "./claude-cloud.js";
import { ownerCheck, type GoogleClaims } from "./google.js";
import { ConnectorAuth } from "./oauth.js";
import { LIMITS, RateLimiter } from "./rate-limit.js";
import type { AuditRow, DeviceRow, HubStore } from "./store.js";
import { cleanPushSub, PUSH, sendPush, type StoredPushSub, type VapidKeys } from "./web-push.js";

/** A device's name when pairing gave none. */
const DEFAULT_NAME: Record<HubDeviceKind, string> = { pc: "PC", phone: "Phone", "claude-chat": "Claude chat" };

/** The Claude chat's fixed opt-in: it appears and reports agent activity, and accepts nothing. */
const CLAUDE_CHAT_OPT_IN = { ...DEFAULT_OPT_IN, reportActivity: true } as const;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Times the hub works with. */
export const HUB_TIMES = {
  sessionIdle: 12 * HOUR,
  sessionMax: 30 * DAY,
  pairing: 5 * MIN,
  ticket: MIN,
  /** A device rotates its token after this (it is told so with each ticket). */
  rotateAfter: 30 * DAY,
  /** A token older than this is refused: the device pairs again. */
  tokenMax: 180 * DAY,
  audit: 30 * DAY,
} as const;

/** Rows the Durable Objects free plan lets the hub write per day (Cloudflare pricing page, 2026-11). */
export const FREE_ROWS_PER_DAY = 100_000;

/** Sockets of connected devices, as the Durable Object has them. */
export interface DeviceSockets {
  /** Sends a frame to every socket of a device; false when it has none. */
  send(deviceId: string, frame: HubFrame): boolean;
  isOnline(deviceId: string): boolean;
  close(deviceId: string, code: number, reason: string): void;
  closeAll(code: number, reason: string): void;
}

/** The hub's setup values (Worker secrets). */
export interface HubConfig {
  allowedEmail?: string;
  /** The hub's ECDH private key as JWK text (for the Claude cloud path). */
  hubPrivateJwk?: string;
  claude?: { triggerId?: string; token?: string };
  /** Web Push (VAPID keys and contact); without it the page offers no notifications. */
  vapid?: VapidKeys;
}

/** What the hub needs from outside. */
export interface HubDeps {
  store: HubStore;
  sockets: DeviceSockets;
  config: HubConfig;
  /** Verifies a Google ID token (throws when it is not valid). */
  verifyIdToken: (token: string) => Promise<GoogleClaims>;
  /** Fires the Claude scheduled task. */
  fireClaude: (text: string, trigger: ClaudeTrigger) => Promise<FireResult>;
  /** Calls a push service (tests pass their own; default the Worker's fetch). */
  fetchPush?: typeof fetch;
  now?: () => number;
}

/** An HTTP-style failure: the status and a short message (never echoing input). */
export interface HubError {
  status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503;
  error: string;
}

const fail = (status: HubError["status"], error: string): HubError => ({ status, error });

/** Whether a value is a {@link HubError}. */
export function isHubError(x: unknown): x is HubError {
  return !!x && typeof x === "object" && "status" in x && "error" in x;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A pairing code like "ABCD-EFGH" (no 0/O, 1/I), about 40 bits. */
function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const c = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** The code as typed (any case, with or without the dash or spaces). */
function normalCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Where a device's push subscription is kept (in settings, deleted with the device). */
function pushKey(deviceId: string): string {
  return `push:${deviceId}`;
}

/** Where a PC's last "waiting for you" count is kept (a number it already sends in clear; deleted with the device). */
function waitingKey(deviceId: string): string {
  return `waiting:${deviceId}`;
}

/** Tasks the Claude connector sent (ids, target and time only; never the text), newest last. */
const CONNECTOR_TASKS = "connectorTasks";

/** One task the Claude connector sent, as the hub remembers it. */
export interface ConnectorTaskRow {
  /** The sealed envelope's id (to see whether the PC took it yet). */
  envId: string;
  taskId: string;
  to: string;
  executor: "pc-local" | "pc-antigravity";
  at: number;
}

/** What the connector's `send_task` asks for. */
export interface ConnectorTaskRequest {
  title: string;
  spec: string;
  /** A PC's id or name; empty: the one PC that takes tasks. */
  device?: string;
  executor: "pc-local" | "pc-antigravity";
}

/** The hub. One instance lives in the Durable Object. */
export class Hub {
  readonly limits: RateLimiter;
  private readonly store: HubStore;
  private readonly sockets: DeviceSockets;
  private readonly now: () => number;
  private hubKey?: Promise<{ privateKey: HubCryptoKey; publicKey: string } | undefined>;
  /** The Claude connector's OAuth (oauth.ts): registered clients, codes and "Connected apps". */
  readonly connector: ConnectorAuth;

  /** @param deps - Storage, sockets, setup values and the outside calls. */
  constructor(private readonly deps: HubDeps) {
    this.store = deps.store;
    this.sockets = deps.sockets;
    this.now = deps.now ?? Date.now;
    this.limits = new RateLimiter(this.now);
    this.connector = new ConnectorAuth(this.store, this.now, (action, grantId) => this.audit(action, grantId ? { deviceId: grantId } : {}));
  }

  // ---- audit and helpers ----

  /** Salted, shortened hash of an IP (the salt is made once and kept in settings). */
  async ipHash(ip: string): Promise<string> {
    let salt = this.store.getSetting("ipSalt");
    if (!salt) {
      salt = randomB64url(16);
      this.store.setSetting("ipSalt", salt);
    }
    return (await sha256Hex(`${salt}|${ip}`)).slice(0, 16);
  }

  private audit(action: string, extra: Omit<AuditRow, "ts" | "action"> = {}): void {
    this.store.audit({ ts: this.now(), action, ...extra });
  }

  /**
   * The hub's own key pair (for the one message type sealed to the hub, the cloud path): the `HUB_PRIVATE_KEY`
   * secret when one is set, otherwise a key the hub makes on first use and keeps in its own storage (so setting up a
   * hub from the dashboard needs no command line).
   */
  private ownKey(): Promise<{ privateKey: HubCryptoKey; publicKey: string } | undefined> {
    this.hubKey ??= (async () => {
      try {
        if (this.deps.config.hubPrivateJwk) return await importPrivateJwk(this.deps.config.hubPrivateJwk);
        let jwk = this.store.getSetting("hubKey");
        if (!jwk) {
          jwk = await exportPrivateJwk((await generateHubKeys(true)).privateKey);
          this.store.setSetting("hubKey", jwk);
        }
        return await importPrivateJwk(jwk);
      } catch {
        return undefined;
      }
    })();
    return this.hubKey;
  }

  /** The Claude path's trigger when it is set up, the hub key exists, and it is not switched off. */
  private async cloudTrigger(): Promise<ClaudeTrigger | undefined> {
    if (this.store.getSetting("cloudOff") === "1") return undefined;
    if (!(await this.ownKey())) return undefined;
    return claudeTrigger(this.deps.config.claude ?? {});
  }

  /** Whether the hub is paused (kill switch 1: no routing, no device sockets). */
  get paused(): boolean {
    return this.store.getSetting("paused") === "1";
  }

  // ---- sign-in and sessions ----

  /**
   * Signs the owner in with a Google ID token: only the pinned account (or, before the pin, the allowed email).
   *
   * @param idToken - From the Google button.
   * @param ip - The caller's IP (only its salted hash is kept).
   * @returns The new session id (for the cookie), or an error.
   */
  async signIn(idToken: string, ip: string): Promise<{ session: string } | HubError> {
    const ipHash = await this.ipHash(ip);
    if (!this.limits.take(`signIn:${ipHash}`, LIMITS.signIn)) return fail(429, "Too many tries.");
    let claims: GoogleClaims;
    try {
      claims = await this.deps.verifyIdToken(idToken);
    } catch {
      this.audit("signin-refused", { ipHash });
      return fail(403, "Not allowed.");
    }
    const verdict = ownerCheck(claims, this.deps.config.allowedEmail, this.store.getSetting("ownerSub"));
    if (verdict === "refuse") {
      this.audit("signin-refused", { ipHash });
      return fail(403, "Not allowed.");
    }
    if (verdict === "pin") {
      this.store.setSetting("ownerSub", claims.sub);
      this.audit("owner-pinned", { ipHash });
    }
    const session = randomB64url(32);
    const t = this.now();
    this.store.putSession({ hash: await sha256Hex(session), createdAt: t, lastUsed: t });
    this.audit("signin", { ipHash });
    return { session };
  }

  /**
   * Checks a session cookie (12 hours idle, 30 days at most).
   *
   * @param session - The cookie value.
   * @returns Whether it is a live session.
   */
  async checkSession(session: string | undefined): Promise<boolean> {
    if (!session || session.length > 100) return false;
    const hash = await sha256Hex(session);
    const s = this.store.session(hash);
    const t = this.now();
    if (!s || t - s.lastUsed > HUB_TIMES.sessionIdle || t - s.createdAt > HUB_TIMES.sessionMax) {
      if (s) this.store.deleteSession(hash);
      return false;
    }
    if (t - s.lastUsed > 5 * MIN) this.store.putSession({ ...s, lastUsed: t });
    return true;
  }

  /** Ends one session. */
  async signOut(session: string): Promise<void> {
    this.store.deleteSession(await sha256Hex(session));
  }

  // ---- pairing (RFC 8628 style) ----

  /**
   * A device asks to pair: it gets a short code to show, and a secret to poll with.
   *
   * @param ip - The caller's IP.
   * @param req - The device's public key, kind and suggested name.
   * @returns The code, poll secret, lifetime and the device key's fingerprint.
   */
  async pairStart(ip: string, req: { publicKey?: unknown; kind?: unknown; name?: unknown }): Promise<{ code: string; pollSecret: string; expiresIn: number; fingerprint: string } | HubError> {
    const ipHash = await this.ipHash(ip);
    if (!this.limits.take(`pairStart:${ipHash}`, LIMITS.pairStart)) return fail(429, "Too many tries.");
    if (this.paused) return fail(503, "The hub is paused.");
    const publicKey = typeof req.publicKey === "string" ? req.publicKey : "";
    try {
      await importPublicKey(publicKey);
    } catch {
      return fail(400, "A device key is needed.");
    }
    const kind: HubDeviceKind = cleanDeviceKind(req.kind);
    const name = (typeof req.name === "string" ? req.name.trim() : "").slice(0, HUB_LIMITS.nameChars) || DEFAULT_NAME[kind];
    const t = this.now();
    if (this.store.pairingCount(t) >= 20) return fail(429, "Too many pairings waiting.");
    const code = newCode();
    const pollSecret = randomB64url(32);
    this.store.putPairing({ codeHash: await sha256Hex(normalCode(code)), pollHash: await sha256Hex(pollSecret), publicKey, kind, name, expiresAt: t + HUB_TIMES.pairing, approved: false });
    this.audit("pair-start", { ipHash });
    return { code, pollSecret, expiresIn: HUB_TIMES.pairing / 1000, fingerprint: await keyFingerprint(publicKey) };
  }

  /**
   * The owner (signed in) looks a code up before approving it: the device's kind, name and key fingerprint, so he can
   * compare the fingerprint with the device's screen first (the hub page's "compare, then connect" step).
   *
   * @param code - The code as typed.
   * @returns The waiting device's kind, name and fingerprint, or an error.
   */
  async pairPeek(code: unknown): Promise<{ kind: HubDeviceKind; name: string; fingerprint: string } | HubError> {
    if (!this.limits.take("pairApprove", LIMITS.pairApprove)) return fail(429, "Too many tries.");
    const c = typeof code === "string" ? normalCode(code) : "";
    if (c.length !== 8) return fail(400, "Type the 8-character code.");
    const p = this.store.pairingByCode(await sha256Hex(c));
    if (!p || p.expiresAt <= this.now()) return fail(404, "That code is not waiting (expired or already used).");
    if (p.approved) return fail(409, "That code was already approved.");
    return { kind: p.kind, name: p.name, fingerprint: await keyFingerprint(p.publicKey) };
  }

  /**
   * The owner (signed in) approves a code he sees on the device; he compares the fingerprint on both screens.
   *
   * @param code - The code as typed.
   * @param name - The name he gives the device (optional).
   * @returns The device's kind, name and key fingerprint, or an error.
   */
  async pairApprove(code: unknown, name?: unknown): Promise<{ kind: HubDeviceKind; name: string; fingerprint: string } | HubError> {
    if (!this.limits.take("pairApprove", LIMITS.pairApprove)) return fail(429, "Too many tries.");
    const c = typeof code === "string" ? normalCode(code) : "";
    if (c.length !== 8) return fail(400, "Type the 8-character code.");
    const codeHash = await sha256Hex(c);
    const p = this.store.pairingByCode(codeHash);
    if (!p || p.expiresAt <= this.now()) return fail(404, "That code is not waiting (expired or already used).");
    if (p.approved) return fail(409, "That code was already approved.");
    const given = typeof name === "string" ? name.trim().slice(0, HUB_LIMITS.nameChars) : "";
    this.store.putPairing({ ...p, approved: true, name: given || p.name });
    this.audit("pair-approve");
    return { kind: p.kind, name: given || p.name, fingerprint: await keyFingerprint(p.publicKey) };
  }

  /**
   * The device polls; once approved it gets its device token, once (only the token's hash is kept).
   *
   * @param ip - The caller's IP.
   * @param pollSecret - The secret from {@link pairStart}.
   * @returns pending / expired, or the new device id, token and the hub's public key.
   */
  async pairPoll(ip: string, pollSecret: unknown): Promise<{ status: "pending" } | { status: "paired"; deviceId: string; token: string; hubKey: string } | HubError> {
    const ipHash = await this.ipHash(ip);
    if (!this.limits.take(`pairPoll:${ipHash}`, LIMITS.pairPoll)) return fail(429, "Too many tries.");
    if (typeof pollSecret !== "string" || pollSecret.length > 100) return fail(400, "Bad request.");
    const p = this.store.pairingByPoll(await sha256Hex(pollSecret));
    if (!p || p.expiresAt <= this.now()) return fail(410, "The pairing expired; start again.");
    if (!p.approved) return { status: "pending" };
    this.store.deletePairing(p.codeHash);
    const t = this.now();
    const deviceId = `d${randomB64url(12)}`;
    const token = `kh_${randomB64url(32)}`;
    this.store.putDevice({ id: deviceId, name: p.name, kind: p.kind, publicKey: p.publicKey, tokenHash: await sha256Hex(token), tokenIssuedAt: t, createdAt: t, busy: false, optIn: { ...(p.kind === "claude-chat" ? CLAUDE_CHAT_OPT_IN : DEFAULT_OPT_IN) }, agents: [] });
    this.audit("pair-done", { deviceId, ipHash });
    this.broadcastPresence();
    return { status: "paired", deviceId, token, hubKey: (await this.ownKey())?.publicKey ?? "" };
  }

  // ---- device tokens, tickets, rotation, revocation ----

  /** The device a bearer token belongs to, unless the token is too old. */
  async deviceForToken(bearer: string | undefined): Promise<DeviceRow | undefined> {
    if (!bearer || !bearer.startsWith("kh_") || bearer.length > 100) return undefined;
    const d = this.store.deviceByTokenHash(await sha256Hex(bearer));
    if (!d || this.now() - d.tokenIssuedAt > HUB_TIMES.tokenMax) return undefined;
    return d;
  }

  /**
   * Exchanges the device token for a one-use, 60-second socket ticket, so the long-lived token never appears in a URL
   * or a log.
   *
   * @param bearer - The device token.
   * @returns The ticket, and whether the token is due to rotate.
   */
  async issueTicket(bearer: string | undefined): Promise<{ ticket: string; rotateDue: boolean } | HubError> {
    const d = await this.deviceForToken(bearer);
    if (!d) return fail(401, "Unknown device.");
    if (!this.limits.take(`ticket:${d.id}`, LIMITS.ticket)) return fail(429, "Too many tries.");
    if (this.paused) return fail(503, "The hub is paused.");
    const ticket = randomB64url(24);
    const t = this.now();
    this.store.pruneTickets(t);
    this.store.putTicket({ hash: await sha256Hex(ticket), deviceId: d.id, expiresAt: t + HUB_TIMES.ticket });
    return { ticket, rotateDue: t - d.tokenIssuedAt > HUB_TIMES.rotateAfter };
  }

  /**
   * Uses a socket ticket (once).
   *
   * @param ticket - From {@link issueTicket}.
   * @returns The device, or undefined when the ticket is unknown, used or expired.
   */
  async takeTicket(ticket: string | null): Promise<DeviceRow | undefined> {
    if (!ticket || ticket.length > 64) return undefined;
    const row = this.store.takeTicket(await sha256Hex(ticket));
    if (!row || row.expiresAt <= this.now()) return undefined;
    return this.store.device(row.deviceId);
  }

  /**
   * The device replaces its own token (every 30 days); the old one stops working at once.
   *
   * @param bearer - The current token.
   * @returns The new token.
   */
  async rotateToken(bearer: string | undefined): Promise<{ token: string } | HubError> {
    const d = await this.deviceForToken(bearer);
    if (!d) return fail(401, "Unknown device.");
    if (!this.limits.take(`ticket:${d.id}`, LIMITS.ticket)) return fail(429, "Too many tries.");
    const token = `kh_${randomB64url(32)}`;
    this.store.putDevice({ ...d, tokenHash: await sha256Hex(token), tokenIssuedAt: this.now() });
    this.audit("token-rotated", { deviceId: d.id });
    return { token };
  }

  /**
   * Removes a device: its token and queued messages go, its socket closes at once.
   *
   * @param deviceId - The device.
   * @returns Whether it existed.
   */
  revoke(deviceId: string): boolean {
    if (!this.store.device(deviceId)) return false;
    this.store.deleteDevice(deviceId);
    this.store.setSetting(pushKey(deviceId), undefined);
    this.store.setSetting(waitingKey(deviceId), undefined);
    this.store.dropQueueFor(deviceId);
    this.store.dropAgentEventsFor(deviceId);
    this.sockets.send(deviceId, { t: "revoked" });
    this.sockets.close(deviceId, 4001, "revoked");
    this.audit("revoke", { deviceId });
    this.broadcastPresence();
    return true;
  }

  // ---- kill switches ----

  /**
   * Kill switch 1: pause stops routing and closes device sockets (data kept); resume lets them back.
   *
   * @param paused - Pause or resume.
   */
  setPaused(paused: boolean): void {
    this.store.setSetting("paused", paused ? "1" : undefined);
    this.audit(paused ? "pause" : "resume");
    if (paused) {
      for (const d of this.store.devices()) this.sockets.send(d.id, { t: "pause", paused: true });
      this.sockets.closeAll(4002, "paused");
    }
  }

  /**
   * Switches the Claude cloud path off or on (the token itself is deleted at claude.ai, outside the hub).
   *
   * @param off - Off or on.
   */
  setCloudOff(off: boolean): void {
    this.store.setSetting("cloudOff", off ? "1" : undefined);
    this.audit(off ? "cloud-off" : "cloud-on");
  }

  /** Kill switch 2: sign out everywhere, revoke every device and every Claude connection, drop every queued message. */
  killAll(): void {
    this.store.deleteAllSessions();
    for (const d of this.store.devices()) {
      this.store.deleteDevice(d.id);
      this.store.setSetting(pushKey(d.id), undefined);
      this.store.setSetting(waitingKey(d.id), undefined);
      this.sockets.send(d.id, { t: "revoked" });
    }
    this.connector.revokeAll();
    this.store.setSetting(CONNECTOR_TASKS, undefined);
    this.store.dropQueue();
    this.store.dropAgentEvents();
    this.sockets.closeAll(4001, "revoked");
    this.audit("kill-all");
  }

  /** Deletes all kept agent activity now (the hub page's "delete agent activity"). */
  dropAgentActivity(): void {
    this.store.dropAgentEvents();
    this.audit("agents-dropped");
  }

  /**
   * A viewer catches up after a reconnect (like SSE's `Last-Event-ID`): the activity batches kept for it after `since`.
   *
   * @param bearer - The viewer's device token.
   * @param since - The last order number it has (0 for all).
   * @returns The envelopes (with `seq` and `at`) and the newest number, or an error.
   */
  async agentsSince(bearer: string | undefined, since: unknown): Promise<{ envs: SealedEnvelope[]; seq: number; more: boolean } | HubError> {
    const d = await this.deviceForToken(bearer);
    if (!d) return fail(401, "Unknown device.");
    if (!this.limits.take(`agents:${d.id}`, LIMITS.ticket)) return fail(429, "Too many tries.");
    const from = typeof since === "string" && /^\d{1,15}$/.test(since) ? Number(since) : 0;
    const rows = this.store.agentEvents(d.id, from, 500);
    const envs = rows.map((r) => ({ ...(JSON.parse(r.env) as SealedEnvelope), seq: r.seq, at: r.createdAt }));
    return { envs, seq: rows.at(-1)?.seq ?? from, more: rows.length === 500 };
  }

  /** Deletes every queued (sealed) message now ("what the hub holds" > delete all). */
  dropQueued(): void {
    this.store.dropQueue();
    this.audit("queue-dropped");
  }

  // ---- presence ----

  /** Every device as the others see it (PCs that opted out of appearing are left out). */
  presence(): HubPresence[] {
    return this.store
      .devices()
      .filter((d) => d.kind === "phone" || d.optIn.appear)
      .map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        publicKey: d.publicKey,
        online: this.sockets.isOnline(d.id),
        ...(d.lastSeen ? { lastSeen: new Date(d.lastSeen).toISOString() } : {}),
        busy: d.busy,
        optIn: d.optIn,
        agents: d.agents,
        ...(d.version ? { version: d.version } : {}),
      }));
  }

  private broadcastPresence(): void {
    const presence = this.presence();
    for (const d of this.store.devices()) this.sockets.send(d.id, { t: "presence", presence });
  }

  /**
   * The owner page's view: presence, switches, and what the hub holds (counts, no content).
   *
   * @returns The state.
   */
  async state(): Promise<{ devices: Array<HubPresence & { fingerprint: string }>; paused: boolean; cloudOff: boolean; cloudReady: boolean; queued: number; agents: { kept: number; writtenToday: number; freeWrites: number }; connections: ReturnType<ConnectorAuth["list"]>; audit: AuditRow[] }> {
    const all = this.store.devices();
    const devices = await Promise.all(
      all.map(async (d) => ({ id: d.id, name: d.name, kind: d.kind, publicKey: d.publicKey, online: this.sockets.isOnline(d.id), ...(d.lastSeen ? { lastSeen: new Date(d.lastSeen).toISOString() } : {}), busy: d.busy, optIn: d.optIn, agents: d.agents, ...(d.version ? { version: d.version } : {}), fingerprint: await keyFingerprint(d.publicKey) })),
    );
    // The free plan counts rows written per day (UTC): the page shows how much of it live activity used today.
    const today = new Date(this.now()).setUTCHours(0, 0, 0, 0);
    const agents = { kept: this.store.agentEventCount(), writtenToday: this.store.agentEventCount(today), freeWrites: FREE_ROWS_PER_DAY };
    return { devices, paused: this.paused, cloudOff: this.store.getSetting("cloudOff") === "1", cloudReady: !!(await this.cloudTrigger()), queued: this.store.queueCount(), agents, connections: this.connector.list(), audit: this.store.auditList(100) };
  }

  // ---- sockets ----

  /**
   * A device's socket opened: welcome it, then hand it what waited for it (oldest first).
   *
   * @param deviceId - The device (from its ticket).
   */
  async onOpen(deviceId: string): Promise<void> {
    const d = this.store.device(deviceId);
    if (!d) return this.sockets.close(deviceId, 4001, "revoked");
    const t = this.now();
    this.store.putDevice({ ...d, lastSeen: t });
    this.sockets.send(deviceId, { t: "welcome", deviceId, hubKey: (await this.ownKey())?.publicKey ?? "", presence: this.presence(), paused: this.paused, rotateDue: t - d.tokenIssuedAt > HUB_TIMES.rotateAfter });
    for (const q of this.store.queued(deviceId)) {
      if (q.expiresAt <= t) continue;
      this.sockets.send(deviceId, { t: "deliver", env: JSON.parse(q.env) as SealedEnvelope });
    }
    this.audit("connect", { deviceId });
    this.broadcastPresence();
  }

  /**
   * A device's socket closed: remember when it was last seen and tell the others.
   *
   * @param deviceId - The device.
   */
  onClose(deviceId: string): void {
    const d = this.store.device(deviceId);
    if (d) this.store.putDevice({ ...d, lastSeen: this.now(), busy: false });
    this.broadcastPresence();
  }

  /**
   * One frame from a device's socket.
   *
   * @param deviceId - The sender (from its ticket, never from the frame).
   * @param raw - The text received.
   */
  async onFrame(deviceId: string, raw: unknown): Promise<void> {
    const refuse = (code: HubRefusal, id?: string) => void this.sockets.send(deviceId, { t: "refused", code, ...(id ? { id } : {}) });
    const d = this.store.device(deviceId);
    if (!d) return this.sockets.close(deviceId, 4001, "revoked");
    if (!this.limits.take(`message:${deviceId}`, LIMITS.message)) return refuse("rate-limited");
    if (this.paused) return refuse("paused");
    const f = parseDeviceFrame(raw);
    // An unknown or malformed frame is refused alone: the device stays connected and online (an older or newer
    // KesherAI may send fields or frames this hub does not know).
    if (!f) return refuse("bad-frame");
    const t = this.now();
    switch (f.t) {
      case "hello":
      case "beat": {
        const next: DeviceRow = { ...d, busy: f.busy, agents: f.agents, ...(f.t === "hello" || f.optIn ? { optIn: f.optIn ?? d.optIn } : {}), ...(f.t === "hello" && f.version ? { version: f.version } : {}) };
        // A phone's opt-in has no meaning (it is not a worker); the Claude chat only reports activity, nothing else.
        if (next.kind === "phone") next.optIn = { ...DEFAULT_OPT_IN };
        if (next.kind === "claude-chat") Object.assign(next, { optIn: CLAUDE_CHAT_OPT_IN, agents: [] });
        if (!next.optIn.reportLinks) next.agents = next.agents.map(({ link: _link, ...a }) => a);
        const changed = JSON.stringify([d.busy, d.optIn, d.agents, d.version]) !== JSON.stringify([next.busy, next.optIn, next.agents, next.version]);
        // Last seen is written at most once a minute (Durable Object rows written are counted).
        if (changed || !d.lastSeen || t - d.lastSeen > MIN) this.store.putDevice({ ...next, lastSeen: t });
        if (changed) this.broadcastPresence();
        return;
      }
      case "ack":
        this.store.dequeue(deviceId, f.id);
        return;
      case "send":
        return this.relay(d, f.env, refuse);
      case "agents":
        return this.agentActivity(d, f.envs, refuse);
      case "ping":
        // On Cloudflare the hub's auto-response answers pings without waking; this is the local (test) path.
        if (!d.lastSeen || t - d.lastSeen > MIN) this.store.putDevice({ ...d, lastSeen: t });
        return void this.sockets.send(deviceId, { t: "pong" });
      case "sync":
        return this.syncPing(d);
    }
  }

  /**
   * A device wrote to the owner's Google Drive: tell the other devices to pull now. The hub only passes the bare
   * ping on (it never sees Drive data); the Claude chat has no Drive and gets none. Pings faster than one per
   * {@link HUB_LIMITS.syncPingMs} are dropped without an answer (a `refused` would slow the sender's live activity,
   * and the timers pull anyway).
   */
  private syncPing(from: DeviceRow): void {
    if (from.kind === "claude-chat" || !this.limits.take(`sync:${from.id}`, LIMITS.syncPing)) return;
    for (const d of this.store.devices()) if (d.id !== from.id && d.kind !== "claude-chat") this.sockets.send(d.id, { t: "sync" });
  }

  /**
   * Live agent activity from a PC: each batch (sealed to one phone) is kept in its run's short ring and delivered at
   * once to that phone's open sockets; nothing is queued or acked (the next batch carries the whole state again).
   */
  private agentActivity(from: DeviceRow, envs: SealedEnvelope[], refuse: (code: HubRefusal, id?: string) => void): void {
    // A PC that opted in, or the Claude chat (its whole job is this; it never takes tasks).
    if (!(from.kind === "pc" && from.optIn.reportActivity) && from.kind !== "claude-chat") return refuse("not-allowed");
    const t = this.now();
    for (const env of envs) {
      if (env.from !== from.id || !env.run) return refuse("not-allowed", env.id);
      const to = this.store.device(env.to);
      if (!to || to.kind !== "phone") continue;
      const row = this.store.addAgentEvent({ to: to.id, from: from.id, run: env.run, n: env.n ?? 0, env: JSON.stringify(env), createdAt: t }, HUB_LIMITS.agentEventsPerRun);
      // The whole table is capped too (scan 168), oldest rows first.
      this.store.capAgentEvents(HUB_LIMITS.agentEventsTotal);
      this.sockets.send(to.id, { t: "deliver", env: { ...env, seq: row.seq, at: t } });
    }
  }

  /** Routes one sealed envelope: to the hub's cloud path, or queued for a device and delivered when it is on. */
  private async relay(from: DeviceRow, env: SealedEnvelope, refuse: (code: HubRefusal, id?: string) => void): Promise<void> {
    if (env.from !== from.id) return refuse("not-allowed", env.id);
    if (env.kind === "task" || env.kind === "cloud") {
      if (!this.limits.take(`task:${from.id}`, LIMITS.task)) return refuse("rate-limited", env.id);
    }
    // A PC answers a task the Claude connector sent (sealed from the hub) with progress and a result sealed to the hub.
    // The hub does not open them (no plain result is ever kept here): taken and dropped; the owner reads the result on
    // the PC's board or the hub page.
    if (env.to === "hub" && (env.kind === "progress" || env.kind === "result")) return void this.sockets.send(from.id, { t: "sent", id: env.id, queued: false });
    if (env.to === "hub") return this.cloud(from, env, refuse);
    // An ask note only rides inside an `approvals` envelope (into the Web Push payload), never on its own.
    if (env.kind === "cloud" || env.kind === "cloud_started" || env.kind === "ask_note") return refuse("not-allowed", env.id);
    const to = this.store.device(env.to);
    if (!to || to.id === from.id) return refuse("no-recipient", env.id);
    // The Claude chat only reports activity (`agents` frames): it neither sends nor gets relayed messages.
    if (from.kind === "claude-chat" || to.kind === "claude-chat") return refuse("not-allowed", env.id);
    if (env.kind === "task" && (to.kind !== "pc" || !to.optIn.appear || !to.optIn.acceptTasks)) return refuse("not-accepting", env.id);
    // A task-inbox report and the approvals waiting on a PC go from a PC to the owner's phones (and the hub page) only.
    if ((env.kind === "inbox_task" || env.kind === "approvals" || env.kind === "approval_request") && (from.kind !== "pc" || to.kind !== "phone")) return refuse("not-allowed", env.id);
    // An approval answer or a command (Run, Cancel) goes from a paired phone (or the hub page) to a PC only, at a human pace.
    if (env.kind === "command_result" && (from.kind !== "pc" || to.kind !== "phone")) return refuse("not-allowed", env.id);
    if (env.kind === "approval_answer" || env.kind === "command") {
      if (from.kind !== "phone" || to.kind !== "pc") return refuse("not-allowed", env.id);
      if (!this.limits.take(`command:${from.id}`, LIMITS.command)) return refuse("rate-limited", env.id);
    }
    const t = this.now();
    // The note is for the push only: the queued and delivered envelope goes without it.
    const { note, ...plain } = env;
    const added = this.store.enqueue({ id: env.id, to: to.id, from: from.id, kind: env.kind, expiresAt: t + env.ttl * 1000, env: JSON.stringify(plain), createdAt: t });
    if (!added) return void this.sockets.send(from.id, { t: "sent", id: env.id, queued: true });
    const online = this.sockets.send(to.id, { t: "deliver", env: plain });
    this.sockets.send(from.id, { t: "sent", id: env.id, queued: !online });
    if (env.kind !== "progress" && env.kind !== "inbox_task" && env.kind !== "approvals" && env.kind !== "command_result") this.audit(`relay-${env.kind}`, { deviceId: from.id });
    if (env.kind === "approvals" && env.waiting !== undefined) {
      this.noteWaiting(from.id, env.waiting);
      await this.notifyWaiting(to.id, env.waiting, online, note);
    }
  }

  /**
   * One approval answer from a phone's service worker (the notification's Approve / Deny or Run / Not now, with the
   * hub page closed and so no socket): the same checks and relay as a socket `send`, for this one kind only. The
   * envelope is sealed and signed by the device itself (the hub cannot read or forge it); the PC checks the device.
   *
   * @param bearer - The device's token.
   * @param body - `{env}`: the sealed `approval_answer`.
   * @returns Whether it was queued for a PC that is off, or why it was refused.
   */
  async answerByHttp(bearer: string | undefined, body: unknown): Promise<{ ok: true; queued: boolean } | HubError> {
    const d = await this.deviceForToken(bearer);
    if (!d) return fail(401, "Unknown device.");
    if (d.kind !== "phone") return fail(403, "Only a phone or a hub page answers approvals.");
    if (this.paused) return fail(503, "The hub is paused.");
    if (!this.limits.take(`message:${d.id}`, LIMITS.message)) return fail(429, "rate-limited");
    const env = parseEnvelope(body && typeof body === "object" ? (body as { env?: unknown }).env : undefined);
    if (!env || env.kind !== "approval_answer" || env.from !== d.id) return fail(400, "bad-frame");
    let refused: HubRefusal | undefined;
    await this.relay(d, env, (code) => void (refused = code));
    if (refused) return fail(refused === "rate-limited" ? 429 : refused === "no-recipient" ? 404 : 403, refused);
    return { ok: true, queued: !this.sockets.isOnline(env.to) };
  }

  // ---- Web Push ("N waiting for you" on a phone whose page is closed) ----

  /**
   * Keeps a browser's push subscription for the paired device that sends it (one per device; a new one replaces it).
   *
   * @param bearer - The device's token.
   * @param body - `{endpoint, keys: {p256dh, auth}, lang}` from the page.
   * @returns ok, or an error.
   */
  async pushSubscribe(bearer: string | undefined, body: unknown): Promise<{ ok: true } | HubError> {
    const d = await this.deviceForToken(bearer);
    if (!d) return fail(401, "Unknown device.");
    if (d.kind !== "phone") return fail(403, "Only a phone or a hub page gets notifications.");
    if (!this.deps.config.vapid) return fail(503, "Notifications are not set up on this hub.");
    const sub = cleanPushSub(body);
    if (!sub) return fail(400, "That is not a push subscription this hub can use.");
    const row: StoredPushSub = { ...sub, count: 0, last: 0 };
    this.store.setSetting(pushKey(d.id), JSON.stringify(row));
    this.audit("push-on", { deviceId: d.id });
    return { ok: true };
  }

  /**
   * Forgets the device's push subscription ("Stop notifying this device").
   *
   * @param bearer - The device's token.
   * @returns ok, or an error.
   */
  async pushUnsubscribe(bearer: string | undefined): Promise<{ ok: true } | HubError> {
    const d = await this.deviceForToken(bearer);
    if (!d) return fail(401, "Unknown device.");
    this.store.setSetting(pushKey(d.id), undefined);
    this.audit("push-off", { deviceId: d.id });
    return { ok: true };
  }

  /** The device's push subscription, if any. */
  private pushSub(deviceId: string): StoredPushSub | undefined {
    const raw = this.store.getSetting(pushKey(deviceId));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StoredPushSub;
    } catch {
      return undefined;
    }
  }

  /**
   * A PC's waiting count reached a phone. With the page open (online) it only notes what the phone saw. Closed, and
   * the count grew past what it last saw or was told: one push, at most one per {@link PUSH.gapMs} (sooner ones
   * collapse into the notification already shown). A subscription the push service calls gone (404, 410) is dropped.
   */
  private async notifyWaiting(deviceId: string, n: number, online: boolean, note?: SealedEnvelope): Promise<void> {
    const sub = this.pushSub(deviceId);
    const vapid = this.deps.config.vapid;
    if (!sub || !vapid) return;
    const t = this.now();
    const save = (row: StoredPushSub) => this.store.setSetting(pushKey(deviceId), JSON.stringify(row));
    if (online || n <= sub.count) {
      if (n !== sub.count) save({ ...sub, count: n });
      return;
    }
    if (t - sub.last < PUSH.gapMs) return;
    save({ ...sub, count: n, last: t });
    try {
      const status = await sendPush(sub, n, vapid, { fetch: this.deps.fetchPush ?? fetch.bind(globalThis), now: t }, note);
      if (status === 404 || status === 410) {
        this.store.setSetting(pushKey(deviceId), undefined);
        this.audit("push-gone", { deviceId });
      } else if (status >= 400) this.audit("push-failed", { deviceId });
    } catch {
      this.audit("push-failed", { deviceId });
    }
  }

  /** The Claude path: open the one message sealed to the hub, fire the scheduled task, answer sealed to the sender. */
  private async cloud(from: DeviceRow, env: SealedEnvelope, refuse: (code: HubRefusal, id?: string) => void): Promise<void> {
    if (env.kind !== "cloud") return refuse("not-allowed", env.id);
    const trigger = await this.cloudTrigger();
    const key = await this.ownKey();
    if (!trigger || !key) return refuse("cloud-off", env.id);
    let body;
    try {
      body = await openEnvelope(env, key.privateKey, from.publicKey);
    } catch {
      return refuse("bad-frame", env.id);
    }
    if (body.type !== "task") return refuse("bad-frame", env.id);
    // Plain text exists only here, in memory, for this one call; nothing of it is stored or logged.
    const r = await this.deps.fireClaude(fireText(body.title, body.spec), trigger);
    this.audit(r.ok ? "cloud-fired" : "cloud-failed", { deviceId: from.id });
    const reply = await sealMessage({ from: "hub", to: from.id, kind: "cloud_started" }, { type: "cloud_started", taskId: body.taskId, ...(r.ok ? (r.sessionUrl ? { sessionUrl: r.sessionUrl } : {}) : { error: r.error }) }, key.privateKey, from.publicKey);
    const t = this.now();
    this.store.enqueue({ id: reply.id, to: from.id, from: "hub", kind: reply.kind, expiresAt: t + reply.ttl * 1000, env: JSON.stringify(reply), createdAt: t });
    this.sockets.send(from.id, { t: "sent", id: env.id, queued: false });
    this.sockets.send(from.id, { t: "deliver", env: reply });
  }

  // ---- the Claude connector's view (mcp.ts): metadata the hub already holds, and tasks sealed by the hub ----

  /** Keeps a PC's latest waiting count (written only when it changes; the PC sends the same number to each phone). */
  private noteWaiting(pcId: string, n: number): void {
    const count = Math.max(0, Math.floor(n));
    let old: number | undefined;
    try {
      old = (JSON.parse(this.store.getSetting(waitingKey(pcId)) ?? "null") as { n?: number } | null)?.n;
    } catch {
      // A damaged value is replaced below.
    }
    if (old !== count) this.store.setSetting(waitingKey(pcId), JSON.stringify({ n: count, at: this.now() }));
  }

  /**
   * Each PC's last "waiting for you" count, as it told the owner's phones (in clear, for Web Push). What waits is
   * sealed to the phones; the hub has the number only.
   *
   * @returns One entry per PC that has reported a count.
   */
  waitingCounts(): Array<{ deviceId: string; name: string; waiting: number; at: number }> {
    return this.store.devices().flatMap((d) => {
      const raw = d.kind === "pc" ? this.store.getSetting(waitingKey(d.id)) : undefined;
      if (!raw) return [];
      try {
        const w = JSON.parse(raw) as { n: number; at: number };
        return [{ deviceId: d.id, name: d.name, waiting: w.n, at: w.at }];
      } catch {
        return [];
      }
    });
  }

  /**
   * What the hub can tell about tasks without opening anything: sealed task messages still waiting for each PC, and
   * the tasks the connector sent (ids, target, time; whether the PC took them yet).
   *
   * @returns Queued counts per PC and the connector's own recent tasks.
   */
  connectorTasks(): { queued: Array<{ deviceId: string; name: string; tasks: number; other: number }>; sent: Array<ConnectorTaskRow & { name: string; taken: boolean }> } {
    const t = this.now();
    const devs = this.store.devices();
    const queued = devs
      .filter((d) => d.kind === "pc")
      .map((d) => {
        const q = this.store.queued(d.id).filter((x) => x.expiresAt > t);
        return { deviceId: d.id, name: d.name, tasks: q.filter((x) => x.kind === "task").length, other: q.filter((x) => x.kind !== "task").length };
      });
    const sent = this.sentTasks().map((s) => ({ ...s, name: devs.find((d) => d.id === s.to)?.name ?? "?", taken: !this.store.queued(s.to).some((q) => q.id === s.envId) }));
    return { queued, sent };
  }

  private sentTasks(): ConnectorTaskRow[] {
    try {
      const x = JSON.parse(this.store.getSetting(CONNECTOR_TASKS) ?? "[]") as unknown;
      return Array.isArray(x) ? (x as ConnectorTaskRow[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * The connector's `send_task`: the hub seals the task with its own key (the key the Claude cloud path already uses)
   * to one PC that takes this kind of task, queues it and delivers it when the PC is on. The text came from Claude in
   * plain form; it exists here in memory for this call only and is never stored or logged. The PC adds it to its board
   * as "from the cloud hub"; an Antigravity task still waits for Run by hand.
   *
   * @param req - Title, spec, which PC and which executor.
   * @param grantId - The connection that asked (for the rate limit and the log).
   * @returns The task id, the PC and whether it was delivered now, or an error in words.
   */
  async sendConnectorTask(req: ConnectorTaskRequest, grantId: string): Promise<{ taskId: string; deviceId: string; name: string; delivered: boolean } | { error: string }> {
    if (this.paused) return { error: "The hub is paused." };
    const title = req.title.trim().slice(0, HUB_LIMITS.titleChars);
    if (!title) return { error: "A title is needed." };
    if (req.spec.length > HUB_LIMITS.specChars) return { error: `The spec is longer than ${HUB_LIMITS.specChars} characters.` };
    const takes = (d: DeviceRow) => d.kind === "pc" && d.optIn.appear && d.optIn.acceptTasks && (req.executor === "pc-local" ? d.optIn.acceptLocal : d.optIn.acceptAntigravity);
    const pcs = this.store.devices().filter((d) => d.kind === "pc");
    const want = (req.device ?? "").trim();
    const named = want ? pcs.filter((d) => d.id === want || d.name.toLowerCase() === want.toLowerCase()) : pcs.filter(takes);
    if (!named.length) return { error: want ? `No paired PC is called "${want.slice(0, 60)}".` : "No PC takes this kind of task (on the PC: Settings › Kesher Cloud)." };
    if (named.length > 1) return { error: `More than one PC fits; name one: ${named.map((d) => d.name).join(", ")}.` };
    const pc = named[0]!;
    if (!takes(pc)) return { error: `"${pc.name}" does not take ${req.executor === "pc-local" ? "local-model" : "Antigravity"} tasks (on the PC: Settings › Kesher Cloud).` };
    if (!this.limits.take(`task:${grantId}`, LIMITS.task)) return { error: "Too many tasks in an hour." };
    const key = await this.ownKey();
    if (!key) return { error: "The hub has no key yet." };
    const taskId = randomB64url(16);
    const env = await sealMessage({ from: "hub", to: pc.id, kind: "task" }, { type: "task", taskId, title, spec: req.spec, executor: req.executor, ifOffline: "wait", createdAt: new Date(this.now()).toISOString() }, key.privateKey, pc.publicKey);
    const t = this.now();
    this.store.enqueue({ id: env.id, to: pc.id, from: "hub", kind: "task", expiresAt: t + env.ttl * 1000, env: JSON.stringify(env), createdAt: t });
    const delivered = this.sockets.send(pc.id, { t: "deliver", env });
    this.store.setSetting(CONNECTOR_TASKS, JSON.stringify([...this.sentTasks(), { envId: env.id, taskId, to: pc.id, executor: req.executor, at: t }].slice(-20)));
    return { taskId, deviceId: pc.id, name: pc.name, delivered };
  }

  /**
   * Writes one connector tool call to the activity log (the tool's name and the connection; no arguments).
   *
   * @param tool - The tool's name.
   * @param grantId - The connection.
   */
  noteToolCall(tool: string, grantId: string): void {
    this.audit(`mcp-${tool}`, { deviceId: grantId });
  }

  // ---- upkeep ----

  /**
   * The cron's cleanup (every 5 minutes): old sessions, pairings, tickets, expired messages and audit lines.
   *
   * @returns How many expired messages were deleted.
   */
  cleanup(): number {
    const t = this.now();
    this.store.pruneSessions(t - HUB_TIMES.sessionIdle, t - HUB_TIMES.sessionMax);
    this.store.prunePairings(t);
    this.store.pruneTickets(t);
    this.store.pruneAudit(t - HUB_TIMES.audit);
    this.store.pruneAgentEvents(t - HUB_LIMITS.agentKeepMs);
    this.connector.cleanup();
    return this.store.pruneQueue(t);
  }
}
