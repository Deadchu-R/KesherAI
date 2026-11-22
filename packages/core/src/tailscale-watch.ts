/**
 * Keeps KesherAI's Tailscale use safe and its backup path known (docs/research/c-20261122-37.md):
 * - At start, once: a Tailscale Funnel left on (an older KesherAI ran `tailscale funnel` at every start, which opened
 *   KesherAI to the whole internet) is turned off, and KesherAI is served to the tailnet only (`tailscale serve`),
 *   unless the user explicitly allowed Funnel.
 * - Every 10 minutes: this computer's tailnet addresses (direct-path.ts), which go into the hub hello and the pairing
 *   link so the phone can reach the PC directly when the hub is down. A change is passed on at once.
 */
import type { TailscaleDirect } from "@kesher/shared";
import type { Tailscale } from "./tailscale.js";

/** How often the tailnet addresses are read again. */
const REFRESH_MS = 10 * 60_000;

/** Reads and keeps this computer's Tailscale addresses; closes a Funnel the user did not choose. */
export class TailscaleWatch {
  private last?: TailscaleDirect;
  private timer?: NodeJS.Timeout;

  /**
   * @param ts - The Tailscale command line.
   * @param o - KesherAI's port, the settings it reads, and who hears about a change of address.
   */
  constructor(
    private readonly ts: Pick<Tailscale, "self" | "direct" | "closeFunnel">,
    private readonly o: { port: () => number; allowFunnel: () => boolean; remoteOn: () => boolean; onChange?: (d: TailscaleDirect | undefined) => void },
  ) {}

  /** @returns The addresses read last (undefined before the first read, or without Tailscale). */
  current(): TailscaleDirect | undefined {
    return this.last;
  }

  /**
   * Closes a Funnel the user did not choose (serving the tailnet instead when remote access is on), reads the
   * addresses, and keeps reading them every 10 minutes.
   *
   * @returns Whether a Funnel was turned off.
   */
  async start(): Promise<boolean> {
    let closed = false;
    if (!this.o.allowFunnel()) {
      const ip = this.o.remoteOn() ? (await this.ts.self()).ip : undefined;
      closed = await this.ts.closeFunnel(this.o.port(), ip).catch(() => false);
      if (closed) console.warn(`[tailscale] a Funnel (open to the internet) was on and is now off${ip ? "; KesherAI is served to the tailnet only" : ""}`);
    }
    await this.refresh();
    this.timer ??= setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
    return closed;
  }

  /** Reads the addresses again now; tells `onChange` when they changed. */
  async refresh(): Promise<TailscaleDirect | undefined> {
    const next = await this.ts.direct(this.o.port()).catch(() => undefined);
    if (JSON.stringify(next ?? null) !== JSON.stringify(this.last ?? null)) {
      this.last = next;
      this.o.onChange?.(next);
    }
    return next;
  }

  /** Stops reading. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
