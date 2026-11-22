/**
 * Three relays, part 2 (Roee 2026-11-22): which relay carries the next sealed message, on the PC and on the phone.
 *
 * Order: the Kesher hub first, then Ably, then Supabase (Tailscale direct is a separate path, direct-path.ts). Both
 * sides keep the hub socket and listen on every configured backup relay at once (idle channels cost nothing), so a
 * message arrives whichever relay the other side sends on; a copy that comes twice is dropped by its envelope id
 * (`ReplayGuard`). The hub counts as failed when there was no socket for 20 s, it answered 503 hub-storage-limit or a
 * Cloudflare 1101, or the open socket heard nothing (no pong) for 60 s; after a failover it is used again only once it
 * has answered for 2 minutes in a row, so a flapping hub does not bounce the traffic. Each backup relay's monthly use is
 * counted locally ({@link RelayUse}); at 80% of its free allowance it is used only as the last fallback.
 */
import { PATH_LABELS } from "./direct-path.js";
import type { BackupRelayKind } from "./relay-keys.js";

/** Where a message goes: the Kesher hub, or a backup relay. */
export type RelayPath = "hub" | BackupRelayKind;

/** The status line for each path, Hebrew and English (the same words on the PC and the phone). */
export const RELAY_PATH_LABELS: Record<RelayPath, { he: string; en: string }> = {
  hub: PATH_LABELS.hub,
  ably: { he: "דרך Ably", en: "via Ably" },
  supabase: { he: "דרך Supabase", en: "via Supabase" },
};

/** The free plans' monthly messages (Ably: 6M, Supabase: 2M). */
export const FREE_ALLOWANCE: Record<BackupRelayKind, number> = { ably: 6_000_000, supabase: 2_000_000 };

/** The share of the allowance after which a relay is only the last fallback. */
export const NEAR_LIMIT = 0.8;

/** No hub socket for this long counts as a failure. */
export const HUB_NO_SOCKET_MS = 20_000;
/** An open hub socket that heard nothing (no pong) for this long counts as a failure. */
export const HUB_SILENT_MS = 60_000;
/** After a failover the hub must answer this long in a row before traffic goes back to it. */
export const HUB_BACK_AFTER_MS = 2 * 60_000;

/** One month's messages per backup relay, counted locally (`month` is UTC "YYYY-MM"). */
export interface RelayUse {
  month: string;
  ably: number;
  supabase: number;
}

/**
 * The month a time falls in (UTC), as the providers count it.
 *
 * @param now - Time, ms.
 * @returns "YYYY-MM".
 */
export function monthOf(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/**
 * This month's use (a count from an earlier month starts again at zero).
 *
 * @param use - The stored counts (may be empty or from an older month).
 * @param now - Time, ms.
 * @returns The counts for this month.
 */
export function useThisMonth(use: Partial<RelayUse> | undefined, now: number): RelayUse {
  const month = monthOf(now);
  if (!use || use.month !== month) return { month, ably: 0, supabase: 0 };
  return { month, ably: Math.max(0, Number(use.ably) || 0), supabase: Math.max(0, Number(use.supabase) || 0) };
}

/**
 * Adds messages to a relay's count. Each side counts what it causes: a publish is two messages (in, and out to the
 * other side), and each message that comes in is one more (its delivery to this side).
 *
 * @param use - The stored counts.
 * @param kind - The relay.
 * @param n - How many messages.
 * @param now - Time, ms.
 * @returns The new counts.
 */
export function countUse(use: Partial<RelayUse> | undefined, kind: BackupRelayKind, n: number, now: number): RelayUse {
  const u = useThisMonth(use, now);
  u[kind] += n;
  return u;
}

/**
 * Whether a relay has used 80% of its free allowance this month.
 *
 * @param use - The stored counts.
 * @param kind - The relay.
 * @param now - Time, ms.
 * @returns True when it should be the last fallback only.
 */
export function nearLimit(use: Partial<RelayUse> | undefined, kind: BackupRelayKind, now: number): boolean {
  return useThisMonth(use, now)[kind] >= FREE_ALLOWANCE[kind] * NEAR_LIMIT;
}

/** A configured backup relay and whether it can carry messages now (`RelayTransport.health().healthy`). */
export interface RelayChoice {
  kind: BackupRelayKind;
  healthy: boolean;
}

/**
 * Follows the hub's link and picks the path for each message. The caller reports the hub socket's events; the router
 * keeps no timers of its own (it reads the clock when asked), so it is cheap and easy to test.
 */
export class RelayRouter {
  private open = false;
  private heardAt = 0;
  /** Since when the hub has answered without a gap (set when the socket opens, reset after a silence). */
  private upSince?: number;
  /** Since when there has been no hub socket (the start counts as no socket). */
  private downSince: number;
  /** Traffic left the hub; it comes back only after {@link HUB_BACK_AFTER_MS} of answers. */
  private failedOver = false;
  private readonly now: () => number;

  /** @param now - The clock (a fake in tests). */
  constructor(now: () => number = Date.now) {
    this.now = now;
    this.downSince = now();
  }

  /** The hub socket opened. */
  hubOpen(): void {
    const t = this.now();
    this.open = true;
    this.heardAt = t;
    this.upSince = t;
  }

  /** Something came from the hub (a frame or a pong). */
  hubHeard(): void {
    const t = this.now();
    if (this.open && t - this.heardAt > HUB_SILENT_MS) this.upSince = t;
    this.heardAt = t;
  }

  /** The hub socket closed. */
  hubClosed(): void {
    if (this.open) this.downSince = this.now();
    this.open = false;
    this.upSince = undefined;
  }

  /** The hub answered 503 hub-storage-limit or a Cloudflare 1101: fail over now. */
  hubFailed(): void {
    this.failedOver = true;
    this.upSince = this.open ? this.now() : undefined;
  }

  /** Checks the failure and return rules against the clock. */
  private update(): void {
    const t = this.now();
    if (!this.open) {
      if (t - this.downSince >= HUB_NO_SOCKET_MS) this.failedOver = true;
      return;
    }
    if (t - this.heardAt > HUB_SILENT_MS) {
      this.failedOver = true;
      return;
    }
    if (this.failedOver && this.upSince !== undefined && t - this.upSince >= HUB_BACK_AFTER_MS) this.failedOver = false;
  }

  /** @returns Whether messages should go through the hub now (its socket is open and it has not failed). */
  hubUsable(): boolean {
    this.update();
    return this.open && !this.failedOver && this.now() - this.heardAt <= HUB_SILENT_MS;
  }

  /** @returns Whether the hub is failed over (for the status line: "the hub is unavailable"). */
  hubDown(): boolean {
    this.update();
    return this.failedOver;
  }

  /**
   * The paths to try for the next message, best first: the hub when usable; then the healthy backup relays in order,
   * those under 80% of their allowance first; the hub last (it may still queue or answer). A relay that is not healthy
   * is skipped.
   *
   * @param relays - The configured backup relays, in failover order, with their health.
   * @param use - This month's counts.
   * @returns The order to try.
   */
  order(relays: readonly RelayChoice[], use: Partial<RelayUse> | undefined): RelayPath[] {
    const t = this.now();
    const healthy = relays.filter((r) => r.healthy);
    const fresh = healthy.filter((r) => !nearLimit(use, r.kind, t)).map((r) => r.kind);
    const tired = healthy.filter((r) => nearLimit(use, r.kind, t)).map((r) => r.kind);
    return this.hubUsable() ? ["hub", ...fresh, ...tired] : [...fresh, ...tired, "hub"];
  }

  /**
   * The path for the next message (the first of {@link order}).
   *
   * @param relays - The configured backup relays with their health.
   * @param use - This month's counts.
   * @returns The path.
   */
  pick(relays: readonly RelayChoice[], use: Partial<RelayUse> | undefined): RelayPath {
    return this.order(relays, use)[0]!;
  }
}
