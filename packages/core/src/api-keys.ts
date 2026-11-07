import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Access keys for apps that use KesherAI's APIs (`/v1` — OpenAI and
 * Anthropic style — and `/mcp`): one per app, so each can be seen and
 * revoked on its own. Only a hash is kept; the key is shown once.
 */

/** A saved key (without the key itself). */
export interface ApiKey {
  id: string;
  name: string;
  /** SHA-256 of the key. */
  hash: string;
  /** The first characters, to tell keys apart. */
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  uses?: number;
}

const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");

/** Keeps the keys in the config. */
export class ApiKeys {
  private dirty = false;
  private timer?: NodeJS.Timeout;

  /**
   * @param keys - The config's list (changed in place).
   * @param save - Saves the config.
   */
  constructor(
    private readonly keys: () => ApiKey[],
    private readonly save: () => Promise<void>,
  ) {}

  /** @returns The keys, newest first. */
  list(): ApiKey[] {
    return [...this.keys()].reverse();
  }

  /**
   * Makes a key for an app.
   *
   * @param name - The app, e.g. "Cursor on the laptop".
   * @returns The key (shown once) and its entry.
   */
  async create(name: string): Promise<{ key: string; entry: ApiKey }> {
    const key = `kai-${randomBytes(24).toString("base64url")}`;
    const entry: ApiKey = { id: randomUUID(), name: name.trim().slice(0, 60) || "App", hash: hashOf(key), prefix: key.slice(0, 10), createdAt: new Date().toISOString() };
    this.keys().push(entry);
    await this.save();
    return { key, entry };
  }

  /** Deletes a key; apps using it stop working. */
  async revoke(id: string): Promise<boolean> {
    const list = this.keys();
    const i = list.findIndex((k) => k.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    await this.save();
    return true;
  }

  /**
   * Checks a key and counts the use.
   *
   * @param given - What the app sent.
   * @returns The key's entry, or undefined.
   */
  verify(given: string | undefined): ApiKey | undefined {
    if (!given || !given.startsWith("kai-")) return undefined;
    const h = Buffer.from(hashOf(given), "hex");
    const k = this.keys().find((x) => {
      const other = Buffer.from(x.hash, "hex");
      return other.length === h.length && timingSafeEqual(other, h);
    });
    if (k) {
      k.lastUsedAt = new Date().toISOString();
      k.uses = (k.uses ?? 0) + 1;
      this.later();
    }
    return k;
  }

  private later() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.dirty) void this.save().catch(() => undefined);
      this.dirty = false;
    }, 30_000);
    this.timer.unref?.();
  }
}
