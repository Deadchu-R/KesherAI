import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * A key of its own for each device that pairs (the phone app, a browser on
 * another computer): only its hash is kept here, it can be removed alone,
 * and the request log shows which device came in.
 */

/** One paired device, as kept in config.json. */
export interface DeviceKey {
  id: string;
  name: string;
  hash: string;
  createdAt: string;
  lastSeen?: string;
  lastAddress?: string;
  /** "mcp": the key opens only /mcp (a connector for an AI app such as Claude), nothing else of KesherAI. */
  scope?: "mcp";
}

const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");

/** The device keys in config.remote.devices. */
export class DeviceKeys {
  /**
   * @param list - config.remote.devices (changed in place).
   * @param save - Persists the config.
   */
  constructor(
    private readonly list: () => DeviceKey[],
    private readonly save: () => Promise<void>,
  ) {}

  /**
   * Makes a key for a newly paired device.
   *
   * @param name - What the device called itself.
   * @returns The key (given to the device once; only its hash is kept).
   */
  async issue(name: string, scope?: "mcp"): Promise<string> {
    const key = `kd_${randomBytes(32).toString("base64url")}`;
    this.list().push({ id: randomUUID(), name: name.replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, 40) || "Device", hash: hashOf(key), createdAt: new Date().toISOString(), ...(scope ? { scope } : {}) });
    await this.save();
    return key;
  }

  /**
   * @param key - What a request presented.
   * @returns The device, or undefined.
   */
  find(key: string | undefined): DeviceKey | undefined {
    if (!key?.startsWith("kd_")) return undefined;
    const h = Buffer.from(hashOf(key));
    return this.list().find((d) => d.hash.length === h.length && timingSafeEqual(Buffer.from(d.hash), h));
  }

  private lastSave = 0;

  /** Notes that a device came in (saved at most once a minute). */
  seen(d: DeviceKey, address: string): void {
    d.lastSeen = new Date().toISOString();
    d.lastAddress = address;
    if (Date.now() - this.lastSave > 60_000) {
      this.lastSave = Date.now();
      void this.save().catch(() => undefined);
    }
  }

  /** @returns The devices for Settings (no hashes). */
  devices(): Array<Omit<DeviceKey, "hash">> {
    return this.list().map(({ hash: _h, ...d }) => d);
  }

  /** Removes one device: its key stops working at once. */
  async remove(id: string): Promise<boolean> {
    const l = this.list();
    const i = l.findIndex((d) => d.id === id);
    if (i < 0) return false;
    l.splice(i, 1);
    await this.save();
    return true;
  }
}
