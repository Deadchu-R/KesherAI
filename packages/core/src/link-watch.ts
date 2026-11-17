import { readFile, writeFile } from "node:fs/promises";

/**
 * Tells the user when the "access from anywhere" address changes (Roee, 2026-11-17: the phone lost the computer after
 * the quick tunnel restarted while the Google sign-in that carries new addresses to the phone had expired). The new
 * link goes to his own Telegram bot and to the phone app's notification (encrypted when it goes through UnifiedPush).
 */
export class LinkWatch {
  private timer?: NodeJS.Timeout;
  private last?: string;

  /**
   * @param file - Where the last address told is kept (KesherAI's data folder).
   * @param current - The address now (undefined while the tunnel is off).
   * @param tell - Sends the new link (the address with the access key).
   * @param token - The access key for the link.
   */
  constructor(
    private readonly file: string,
    private readonly current: () => string | undefined,
    private readonly tell: (link: string, address: string) => Promise<void>,
    private readonly token: () => string,
  ) {}

  /** Checks now and every minute. */
  async start(everyMs = 60_000): Promise<void> {
    this.last = await readFile(this.file, "utf8").then((t) => (JSON.parse(t) as { url?: string }).url, () => undefined);
    await this.check();
    this.timer = setInterval(() => void this.check().catch(() => undefined), everyMs);
    this.timer.unref?.();
  }

  /** Stops checking. */
  stop(): void {
    clearInterval(this.timer);
  }

  /** @returns Whether a new address was told. */
  async check(): Promise<boolean> {
    const url = this.current();
    if (!url || url === this.last) return false;
    const first = this.last === undefined;
    this.last = url;
    await writeFile(this.file, JSON.stringify({ url, at: new Date().toISOString() })).catch(() => undefined);
    // The very first address is not news (nothing on the phone points elsewhere yet).
    if (first) return false;
    const link = `${url.replace(/\/$/, "")}/?token=${encodeURIComponent(this.token())}`;
    await this.tell(link, url).catch(() => undefined);
    return true;
  }
}
