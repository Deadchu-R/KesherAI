import { BEACON_SERVER, beaconTopic, sealLink } from "@kesher/shared";

/**
 * The computer's half of finding it again (packages/shared/src/link-beacon.ts): while "access from anywhere" is on,
 * its address goes, encrypted for each paired phone's key, to that phone's ntfy topic: at once when the address
 * changes, and again every few hours so a phone that was off for a while still finds it (ntfy keeps a message
 * about 12 hours).
 */
export class LinkBeaconPoster {
  private timer?: NodeJS.Timeout;
  private last?: string;
  private lastAt = 0;

  /**
   * @param url - The internet address now (undefined while it is off).
   * @param secrets - The SHA-256 (hex) of each key to tell: the paired phones' (as kept) and the shared token's.
   * @param name - This computer's name.
   * @param post - Sends one message to a topic (for tests).
   * @param again - How often the same address is sent again (ms).
   */
  constructor(
    private readonly url: () => string | undefined,
    private readonly secrets: () => Promise<string[]>,
    private readonly name: () => string,
    private readonly post: (topic: string, body: string) => Promise<void> = async (topic, body) => {
      const r = await fetch(`${BEACON_SERVER}/${topic}`, { method: "POST", body, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`ntfy ${r.status}`);
    },
    private readonly again = 6 * 3600_000,
  ) {}

  /** Checks now and every few minutes. */
  start(everyMs = 5 * 60_000): void {
    void this.check().catch(() => undefined);
    this.timer = setInterval(() => void this.check().catch(() => undefined), everyMs);
    this.timer.unref?.();
  }

  /** Stops. */
  stop(): void {
    clearInterval(this.timer);
  }

  /** @returns How many phones were told (0 when nothing was due). */
  async check(now = Date.now()): Promise<number> {
    const url = this.url();
    if (!url || !/^https:\/\//.test(url)) return 0;
    if (url === this.last && now - this.lastAt < this.again) return 0;
    let told = 0;
    for (const secret of [...new Set(await this.secrets())].slice(0, 20)) {
      const ok = await this.post(await beaconTopic(secret), await sealLink(secret, { url, name: this.name().slice(0, 60), t: now })).then(() => true, () => false);
      if (ok) told++;
    }
    // Sent again next time when nothing got through (the internet was down).
    if (told) {
      this.last = url;
      this.lastAt = now;
    }
    return told;
  }
}
