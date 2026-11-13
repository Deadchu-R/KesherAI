import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ServerResponse } from "node:http";
import type { DeviceKey } from "./device-keys.js";
import type { Note } from "./notify.js";

/**
 * Notifications shown by the KesherAI phone app itself, the way other phone
 * apps notify (research: docs/RESEARCH_LOG.md, 2026-11-11):
 *
 * - **Live connection:** the app holds an event stream to this computer (like Home Assistant's "persistent
 *   connection") while it can reach it (home network, Tailscale, the internet link).
 * - **UnifiedPush:** when it cannot, a distributor app on the phone (ntfy) delivers for it. The message is
 *   encrypted for the phone (Web Push, RFC 8291), so the distributor's server sees only ciphertext.
 *
 * Each note goes one way only: live when the phone is connected, otherwise UnifiedPush. A note about a chat
 * carries the chat as its id, so the phone keeps one notification per chat (updated, not stacked) and removes
 * it when the chat is answered anywhere ("clear").
 */

/** What the phone app receives. */
export interface PhoneMessage {
  /** "show" a notification, or "clear" the one with this id. */
  t: "show" | "clear";
  /** One notification per id (a chat, or a download). */
  id: string;
  /** The Android channel: waiting (pops up), done, downloads. */
  ch?: "waiting" | "done" | "downloads";
  title?: string;
  body?: string;
  /** The app page it opens (#/…). */
  path?: string;
  /** Buttons: each POSTs to its path on this computer. */
  actions?: Array<{ label: string; path: string }>;
  /** On the live connection: the phone confirms it with POST /api/phone-push/ack (a sleeping phone's connection can look open). */
  seq?: number;
}

/** How long a live phone has to confirm a message before it goes through UnifiedPush instead. */
const ACK_MS = 8000;

/** The largest UnifiedPush message (the spec allows 4096 bytes; encryption adds 103). */
const MAX_PLAIN = 3900;

/**
 * Encrypts one message for a phone (RFC 8291, aes128gcm, one record).
 *
 * @param plain - The message.
 * @param p256dh - The phone's public key (base64url, 65 bytes uncompressed P-256).
 * @param auth - The phone's auth secret (base64url, 16 bytes).
 * @param fixed - For tests only: the server's key pair and salt.
 * @returns The body to POST.
 */
export function webPushEncrypt(plain: Buffer, p256dh: string, auth: string, fixed?: { privateKey: Buffer; salt: Buffer }): Buffer {
  const uaPublic = Buffer.from(p256dh, "base64url");
  const authSecret = Buffer.from(auth, "base64url");
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("The phone's push keys are not valid.");
  const ecdh = createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(fixed.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const salt = fixed?.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/**
 * Whether an address is on this computer, the home network, Tailscale or another private range.
 *
 * @param ip - An IPv4 or IPv6 address.
 * @returns True for loopback, private, link-local, CGNAT, unique-local and unspecified addresses.
 */
export function privateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a = 0, b = 0] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff");
}

/**
 * Checks a UnifiedPush address before keeping it (the spec's guard against making this computer call into
 * the home network): https only, at most 1000 characters, no user or password, and a name that resolves only
 * to public addresses.
 *
 * @param endpoint - The address the phone sent.
 * @param resolve - Looks a name up (for tests).
 * @returns An error to show, or undefined when it is fine.
 */
export async function checkEndpoint(endpoint: string, resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((r) => r.address)): Promise<string | undefined> {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return "The push address is not a web address.";
  }
  if (u.protocol !== "https:" || endpoint.length > 1000 || u.username || u.password) return "The push address must be https, without a user name, up to 1000 characters.";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (!ips.length) return "The push server's name could not be found.";
  if (ips.some(privateAddress)) return "The push server is on a private network; KesherAI only sends to public push servers.";
  return undefined;
}

/**
 * Turns a KesherAI notification into what the phone shows.
 *
 * @param n - The notification.
 * @returns The phone message (cut to fit a push message).
 */
export function phoneMessage(n: Note): PhoneMessage {
  const chat = /^#\/c\/([\w-]+)/.exec(n.path ?? "")?.[1];
  const id = n.ref ?? chat ?? (n.path === "#/models" ? "downloads" : `n-${n.title.slice(0, 40)}`);
  const ch = n.tags?.includes("raised_hand") || (n.priority ?? 3) >= 4 ? "waiting" : n.tags?.includes("inbox_tray") || n.path === "#/models" ? "downloads" : "done";
  const m: PhoneMessage = { t: "show", id, ch, title: n.title.slice(0, 120), body: n.body.slice(0, 600), ...(n.path ? { path: n.path } : {}), ...(n.actions?.length ? { actions: n.actions } : {}) };
  while (Buffer.byteLength(JSON.stringify(m)) > MAX_PLAIN && (m.body ?? "").length > 0) m.body = (m.body ?? "").slice(0, Math.floor((m.body ?? "").length / 2));
  return m;
}

/** The phone apps that can be reached, and how. */
export class PhonePush {
  /** Live connections, by device id. */
  private readonly live = new Map<string, Set<ServerResponse>>();
  private readonly ping: NodeJS.Timeout;
  private seq = 0;
  private readonly waitingAck = new Map<number, { device: string; done: () => void }>();

  /**
   * @param devices - The paired devices (config.remote.devices; a removed device gets nothing).
   * @param save - Persists the config (a push address that stopped working is dropped).
   * @param doFetch - For tests.
   * @param ackMs - How long a live phone has to confirm (tests use less).
   */
  constructor(
    private readonly devices: () => DeviceKey[],
    private readonly save: () => Promise<void>,
    private readonly doFetch: typeof fetch = fetch,
    private readonly ackMs = ACK_MS,
  ) {
    // Keeps the connections open through proxies and lets the phone notice a dead one.
    this.ping = setInterval(() => {
      for (const set of this.live.values()) for (const r of set) r.write(": ping\n\n");
    }, 20_000);
    this.ping.unref?.();
  }

  /**
   * Holds a phone's live connection open until it closes.
   *
   * @param deviceId - The paired device.
   * @param res - The response to write events to.
   */
  attach(deviceId: string, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": connected\n\n");
    const set = this.live.get(deviceId) ?? new Set();
    // At most 3 connections per phone (a reconnecting app must not pile them up): the oldest goes.
    if (set.size >= 3) {
      const oldest = set.values().next().value;
      if (oldest) {
        set.delete(oldest);
        oldest.end();
      }
    }
    set.add(res);
    this.live.set(deviceId, set);
    res.on("close", () => {
      set.delete(res);
      if (!set.size) this.live.delete(deviceId);
    });
  }

  /** What each phone app last said about itself (see hello). */
  private readonly said = new Map<string, { at: string; plugin: boolean; permission?: boolean; live?: boolean; error?: string }>();

  /**
   * The phone app says, when it opens, whether it has its own notifications and how they are set, so the
   * computer's settings can show "on", "needs an update" or the phone's error instead of leaving the user to guess.
   *
   * @param deviceId - The paired device.
   * @param info - What it reported.
   */
  hello(deviceId: string, info: { plugin: boolean; permission?: boolean; live?: boolean; error?: string }): void {
    this.said.set(deviceId, { at: new Date().toISOString(), plugin: info.plugin, ...(info.permission !== undefined ? { permission: info.permission } : {}), ...(info.live !== undefined ? { live: info.live } : {}), ...(info.error ? { error: info.error.slice(0, 200) } : {}) });
  }

  /** @returns Every paired phone app that has reported, with whether it is connected now. */
  phones(): Array<{ id: string; name: string; connected: boolean; push: boolean; at: string; plugin: boolean; permission?: boolean; live?: boolean; error?: string }> {
    return this.devices().flatMap((d) => {
      const s = this.said.get(d.id);
      return s ? [{ id: d.id, name: d.name, connected: this.live.has(d.id), push: !!d.push, ...s }] : [];
    });
  }

  /** @returns Whether any phone app can get notifications now (live, or with a push address). */
  hasReceivers(): boolean {
    return this.devices().some((d) => this.live.has(d.id) || !!d.push);
  }

  /**
   * @param deviceId - A paired device.
   * @returns How that device gets notifications.
   */
  status(deviceId: string): { live: boolean; push: boolean } {
    return { live: this.live.has(deviceId), push: !!this.devices().find((d) => d.id === deviceId)?.push };
  }

  /**
   * Sends a message to every phone app: live if connected, otherwise through its push address.
   *
   * @param m - The message.
   * @returns Whether at least one phone got it.
   */
  async deliver(m: PhoneMessage): Promise<boolean> {
    const plain = Buffer.from(JSON.stringify(m));
    const results = await Promise.all(
      this.devices().map(async (d) => {
        const live = this.live.get(d.id);
        if (live?.size) {
          // A phone asleep (Doze) keeps a connection that looks open: without its confirmation, use UnifiedPush.
          const seq = ++this.seq;
          const acked = new Promise<boolean>((resolve) => {
            // Not unref'd: a short wait someone is awaiting (an unref'd timer let the process end under it in CI).
            const t = setTimeout(() => (this.waitingAck.delete(seq), resolve(false)), this.ackMs);
            this.waitingAck.set(seq, { device: d.id, done: () => (clearTimeout(t), this.waitingAck.delete(seq), resolve(true)) });
          });
          for (const r of live) r.write(`data: ${JSON.stringify({ ...m, seq })}\n\n`);
          if (await acked) return true;
        }
        if (!d.push) return false;
        try {
          const r = await this.doFetch(d.push.endpoint, {
            method: "POST",
            redirect: "manual",
            headers: { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: m.t === "clear" ? "3600" : "86400", urgency: m.ch === "waiting" ? "high" : "normal" },
            body: new Uint8Array(webPushEncrypt(plain, d.push.p256dh, d.push.auth)),
            signal: AbortSignal.timeout(15_000),
          });
          if (r.status === 404 || r.status === 410) {
            delete d.push;
            await this.save().catch(() => undefined);
          }
          return r.status >= 200 && r.status < 300;
        } catch {
          return false;
        }
      }),
    );
    return results.some(Boolean);
  }

  /**
   * The phone confirms a message it got on the live connection.
   *
   * @param seq - The message's number.
   * @param deviceId - The device confirming (only the device it was sent to counts).
   */
  ack(seq: number, deviceId: string): void {
    const w = this.waitingAck.get(seq);
    if (w?.device === deviceId) w.done();
  }

  /** Stops the keep-alive timer (tests). */
  close(): void {
    clearInterval(this.ping);
    for (const set of this.live.values()) for (const r of set) r.end();
    this.live.clear();
  }
}
