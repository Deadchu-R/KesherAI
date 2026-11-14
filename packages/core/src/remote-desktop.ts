/**
 * Controlling this computer from the phone (asked for: "like Google Remote Desktop"). The person sees the screen as
 * pictures and taps, types and scrolls; it goes through KesherAI's own screen and input code (computer.ts).
 *
 * Safety, like Chrome Remote Desktop's PIN: off until switched on ON THE COMPUTER, where a PIN of 6+ digits is set
 * (kept only as a salted scrypt hash). A session needs the PIN; five wrong PINs lock it for 10 minutes. One session at
 * a time, ended after 15 idle minutes, from the computer (its banner), or by switching it off. The computer's
 * window shows a banner while a session is on. This is the person themselves, so no app is off limits here (unlike
 * the model's computer control).
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { screenControl, type Backend } from "./computer.js";

/** What is kept in the config. */
export interface RemoteDesktopSettings {
  enabled: boolean;
  /** "salt:hash" (scrypt), never the PIN. */
  pinHash?: string;
  /** Phones allowed for good by the owner ("Always"): a hash of each phone's own id, its name, when. */
  trusted?: Array<{ id: string; name: string; at: string }>;
}

/** A phone's own id as kept (never the id itself). */
export function deviceHash(id: string): string {
  return createHash("sha256").update(`kesher-remote:${id}`).digest("hex").slice(0, 32);
}

/** Makes the kept form of a PIN. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}

/** Whether a PIN matches its kept form (in constant time). */
export function pinMatches(pin: string, kept: string | undefined): boolean {
  if (!kept) return false;
  const [salt, hash] = kept.split(":");
  if (!salt || !hash) return false;
  const got = scryptSync(pin, salt, 32);
  const want = Buffer.from(hash, "hex");
  return want.length === got.length && timingSafeEqual(got, want);
}

/** One input from the phone, in the picture's pixels. */
export type RemoteInput =
  | { kind: "click" | "double" | "right"; x: number; y: number }
  | { kind: "move"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; amount: number }
  | { kind: "type"; text: string }
  | { kind: "key"; combo: string };

const IDLE_MS = 15 * 60_000;

/** The remote session: PIN check, pictures, input. */
export class RemoteDesktop {
  private session: { token: string; at: number; started: number; device: string } | undefined;
  private wrong = 0;
  private lockedUntil = 0;
  /** Phones asking for control without the PIN, until the owner answers (5 minutes). */
  private requests = new Map<string, { code: string; device: string; deviceId: string; at: number; state: "waiting" | "approved" | "denied"; token?: string }>();
  /** How the last picture maps to the desktop. */
  private map = { scale: 1, left: 0, top: 0 };

  /**
   * @param settings - The config's settings (read each time).
   * @param be - The screen and input (the real one; a test gives its own).
   */
  constructor(private settings: () => RemoteDesktopSettings, private be: () => Backend = screenControl) {}

  /** For the computer's banner and Settings. */
  status(): { enabled: boolean; hasPin: boolean; active: boolean; since?: string; device?: string; locked: boolean } {
    this.expire();
    const s = this.settings();
    return { enabled: s.enabled, hasPin: !!s.pinHash, active: !!this.session, ...(this.session ? { since: new Date(this.session.started).toISOString(), device: this.session.device } : {}), locked: Date.now() < this.lockedUntil };
  }

  private expire() {
    if (this.session && (Date.now() - this.session.at > IDLE_MS || !this.settings().enabled)) this.session = undefined;
  }

  /**
   * Starts a session (ending any other).
   *
   * @returns The session's token, or throws why not.
   */
  start(pin: string, device: string): string {
    const s = this.settings();
    if (!s.enabled || !s.pinHash) throw new Error("Remote control is off. Switch it on and set a PIN on the computer (the menu → Remote control).");
    if (Date.now() < this.lockedUntil) throw new Error("Too many wrong PINs: try again in a few minutes.");
    if (!pinMatches(String(pin), s.pinHash)) {
      if (++this.wrong >= 5) {
        this.wrong = 0;
        this.lockedUntil = Date.now() + 10 * 60_000;
      }
      throw new Error("Wrong PIN.");
    }
    this.wrong = 0;
    return this.open(device);
  }

  private open(device: string): string {
    const token = randomBytes(24).toString("hex");
    this.session = { token, at: Date.now(), started: Date.now(), device: device.slice(0, 60) || "phone" };
    return token;
  }

  /**
   * A phone asks for control without the PIN: a phone the owner allowed for good starts at once; any other waits for
   * the owner's answer (on the computer, or the Approve buttons on the owner's phone).
   *
   * @param deviceId - The phone's own random id (kept only as a hash).
   * @returns The request's id and, for the owner's buttons, its one-time code; or a token right away.
   */
  request(device: string, deviceId: string): { id: string; code?: string; token?: string } {
    const s = this.settings();
    if (!s.enabled) throw new Error("Remote control is off on that computer.");
    if (!/^[\w-]{16,80}$/.test(deviceId)) throw new Error("Unknown phone.");
    const id = randomBytes(12).toString("hex");
    if ((s.trusted ?? []).some((t) => t.id === deviceHash(deviceId))) return { id, token: this.open(device) };
    for (const [k, v] of this.requests) if (Date.now() - v.at > 5 * 60_000) this.requests.delete(k);
    if (this.requests.size >= 5) throw new Error("Too many requests waiting.");
    const code = randomBytes(16).toString("hex");
    this.requests.set(id, { code, device: device.slice(0, 60) || "phone", deviceId, at: Date.now(), state: "waiting" });
    return { id, code };
  }

  /** The requests waiting for the owner (for the computer's screen). */
  waiting(): Array<{ code: string; device: string; at: string }> {
    return [...this.requests.values()].filter((r) => r.state === "waiting" && Date.now() - r.at < 5 * 60_000).map((r) => ({ code: r.code, device: r.device, at: new Date(r.at).toISOString() }));
  }

  /**
   * The owner's answer. "always" keeps the phone (as a hash) so it needs no approval next time.
   *
   * @returns The phone to keep for good, when "always"; false when the code is unknown or too old.
   */
  decide(code: string, d: "once" | "always" | "deny"): false | { keep?: { id: string; name: string; at: string } } {
    const r = [...this.requests.values()].find((x) => x.code === code && x.state === "waiting" && Date.now() - x.at < 5 * 60_000);
    if (!r) return false;
    if (d === "deny") {
      r.state = "denied";
      return {};
    }
    r.state = "approved";
    r.token = this.open(r.device);
    return d === "always" ? { keep: { id: deviceHash(r.deviceId), name: r.device, at: new Date().toISOString() } } : {};
  }

  /** The phone asks how its request went (its own id must match). */
  poll(id: string, deviceId: string): { state: "waiting" | "approved" | "denied" | "gone"; token?: string } {
    const r = this.requests.get(id);
    if (!r || r.deviceId !== deviceId || Date.now() - r.at > 5 * 60_000) return { state: "gone" };
    if (r.state !== "waiting") this.requests.delete(id);
    return { state: r.state, ...(r.token ? { token: r.token } : {}) };
  }

  /** Ends the session (from the computer's banner, the phone, or Settings). */
  end(): void {
    this.session = undefined;
  }

  private check(token: string) {
    this.expire();
    const s = this.session;
    if (!s || token.length !== s.token.length || !timingSafeEqual(Buffer.from(token), Buffer.from(s.token))) throw new Error("The session ended. Enter the PIN again.");
    s.at = Date.now();
  }

  /** A picture of the screen, at most `maxWidth` wide. */
  async frame(token: string, maxWidth: number): Promise<{ png: Buffer; width: number; height: number }> {
    this.check(token);
    const shot = await this.be().screenshot(Math.min(1920, Math.max(320, Math.round(maxWidth) || 1280)));
    this.map = { scale: shot.scale, left: shot.left ?? 0, top: shot.top ?? 0 };
    return { png: shot.png, width: shot.width, height: shot.height };
  }

  /** Carries out one tap, key or scroll (picture pixels to the desktop's). */
  async input(token: string, i: RemoteInput): Promise<void> {
    this.check(token);
    const be = this.be();
    const px = (x: number, y: number): [number, number] => [this.map.left + x * this.map.scale, this.map.top + y * this.map.scale];
    switch (i.kind) {
      case "click":
      case "double":
      case "right": {
        const [x, y] = px(i.x, i.y);
        return be.click(x, y, i.kind === "right" ? "right" : "left", i.kind === "double");
      }
      case "move": {
        const [x, y] = px(i.x, i.y);
        return be.move(x, y);
      }
      case "scroll": {
        const [x, y] = px(i.x, i.y);
        return be.scroll(x, y, Math.max(-20, Math.min(20, Math.round(i.amount))));
      }
      case "type":
        return be.type(String(i.text).slice(0, 500));
      case "key":
        if (!/^[\w+ -]{1,40}$/.test(i.combo)) throw new Error("Unknown key.");
        return be.key(i.combo);
    }
  }
}
