/**
 * When the PC is busy, downloads give way (research c-20261121-41 §2.6, §2.9, §5.6): while the local chat model is
 * answering they slow down to a share of their speed, and while Unity or Unreal is in Play they pause. Both come
 * back to full speed by themselves. These are the pure rules; the download manager applies them.
 */

/** What keeps the PC busy right now. */
export interface BusyState {
  /** A local model is answering (a llama.cpp turn runs). */
  chat: boolean;
  /** Unity or Unreal is in Play. */
  playing: boolean;
}

/** What a download does about it: nothing, runs at a share of its speed, or waits. */
export type BusyMode = "none" | "slowed" | "paused";

/** The user's choices for the rules. */
export interface BusySettings {
  /** "Slow downloads while the PC is busy". */
  enabled: boolean;
  /** The share of the speed a download keeps while the chat answers (0.1 to 1). */
  share: number;
}

/** The share of the speed kept while the chat answers, unless the user changed it. */
export const DEFAULT_BUSY_SHARE = 0.5;

/** The slowest a slowed download goes (bytes per second), so it never stalls completely. */
export const MIN_SLOWED_BPS = 256 * 1024;

/** The speed taken as "full" when nothing is known yet (no limit set and no download has run): 8 MB/s. */
export const FALLBACK_BPS = 8 * 1024 ** 2;

/**
 * Keeps a share inside 0.1 to 1 (a bad value from a file or a request becomes the default).
 *
 * @param n - The share asked for.
 * @returns A usable share.
 */
export function clampShare(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_BUSY_SHARE;
  return Math.min(1, Math.max(0.1, v));
}

/**
 * What one download does now. A game in Play pauses it, a chat answer slows it, unless the setting is off or this
 * download was marked "Don't slow" (it then always runs at full speed).
 *
 * @param state - What keeps the PC busy.
 * @param settings - The user's choices.
 * @param dontSlow - The download's own "Don't slow" mark.
 * @returns The mode.
 */
export function busyMode(state: BusyState, settings: Pick<BusySettings, "enabled">, dontSlow = false): BusyMode {
  if (!settings.enabled || dontSlow) return "none";
  if (state.playing) return "paused";
  if (state.chat) return "slowed";
  return "none";
}

/**
 * The speed limit while the chat answers, for all downloads together: the share of the user's limit, or of the best
 * speed seen when there is no limit.
 *
 * @param limit - The user's limit in bytes per second (0: none).
 * @param peak - The best combined speed seen so far (bytes per second, 0 when not known).
 * @param share - The share to keep (see {@link clampShare}).
 * @returns Bytes per second, never below {@link MIN_SLOWED_BPS}.
 */
export function slowedLimit(limit: number, peak: number, share: number): number {
  const full = limit > 0 ? limit : peak > 0 ? peak : FALLBACK_BPS;
  return Math.max(MIN_SLOWED_BPS, Math.floor(full * clampShare(share)));
}
