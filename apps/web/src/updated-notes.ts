/** Release shape of `/api/updates/history` (newest first). */
export interface ReleaseNotes {
  version: string;
  notes: string[];
}

/** @returns The numeric parts of a version like `v0.6.439`, for comparing. */
function parts(v: string): number[] {
  return v.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
}

/**
 * Compares two versions like `0.6.9` and `0.6.10`.
 *
 * @returns Positive when `a` is newer than `b`, negative when older, 0 when equal.
 */
export function cmpVersion(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * The versions this device has not seen yet: newer than `seen`, up to and including `current`, newest first, with
 * their notes. A skipped release (no entry in the list) still counts as one step, so a card never loses the line
 * about the version it is for.
 *
 * @param releases - What's-new list from the computer (any order).
 * @param seen - The version the device last saw.
 * @param current - The version the computer runs now.
 * @param limit - How many versions and how many notes per version to keep (default 4 and 3).
 * @returns Newest first; empty when nothing is new.
 */
export function versionsSince(releases: ReleaseNotes[], seen: string, current: string, limit = 4, perVersion = 3): ReleaseNotes[] {
  if (cmpVersion(current, seen) <= 0) return [];
  const between = releases
    .filter((r) => cmpVersion(r.version, seen) > 0 && cmpVersion(r.version, current) <= 0)
    .sort((a, b) => cmpVersion(b.version, a.version));
  const out = between.slice(0, limit).map((r) => ({ version: r.version.replace(/^v/, ""), notes: r.notes.slice(0, perVersion) }));
  if (!out.some((r) => cmpVersion(r.version, current) === 0)) out.unshift({ version: current.replace(/^v/, ""), notes: [] });
  return out.slice(0, limit);
}

/**
 * Whether the phone app is older than what the computer's release expects: compares the app's own version with
 * the newest phone app the updater found.
 *
 * @param current - The installed app version (e.g. `0.6.12`).
 * @param latest - The newest phone app version, when known.
 */
export function phoneAppBehind(current: string | undefined, latest: string | undefined): boolean {
  return !!current && !!latest && cmpVersion(latest, current) > 0;
}
