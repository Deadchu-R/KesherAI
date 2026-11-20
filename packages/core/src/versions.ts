/**
 * Versions of a document, sheet or slide deck (the chat's side panel shows them as "v3"; design DocPanel). One rule
 * for the three stores: the state before a change is kept as a version, the last {@link MAX_VERSIONS} only.
 * The user's typing in an open page makes one version a minute (not one per keystroke); a tool's edit (the model
 * wrote it) and a restore always make their own version, so each one can be viewed and restored.
 */

/** How many earlier versions an item keeps. */
export const MAX_VERSIONS = 20;

/** Typing within this long after the last version is merged into it. */
export const MERGE_MS = 60_000;

/** One kept version: the item's revision and time then, its number ("v3") and its content. */
export interface VersionEntry {
  rev: number;
  at: string;
  /** Its number, counted from 1 (older files have none; see {@link versionNumber}). */
  ver?: number;
}

/** The fields of an item that has versions. */
export interface Versioned<V extends VersionEntry> {
  /** The current state's number (older files have none). */
  ver?: number;
  versions?: V[];
  /** The current state came from a tool or a restore: the next change keeps it as a version, even typing. */
  sealed?: boolean;
}

/**
 * The current state's version number: the stored one, or for an older file one more than its kept versions.
 *
 * @param item - The document, sheet or deck.
 */
export function versionNumber(item: Versioned<VersionEntry>): number {
  return item.ver ?? (item.versions?.length ?? 0) + 1;
}

/**
 * Keeps the state before a change as a version when the change is a new one: always for a tool edit or a restore
 * (`force`) and for the change after one (so the model's text is never merged into the user's typing), else when
 * the last version is older than {@link MERGE_MS} (or there is none). Numbers the kept entry
 * and the new current state, and drops the oldest past {@link MAX_VERSIONS}.
 *
 * @param item - The item, already changed in place (its `versions` and `ver` are updated here).
 * @param before - Its state before the change (its rev, time and content), without a number.
 * @param force - A tool's edit or a restore: always its own version.
 * @returns Whether a version was kept.
 */
export function keepVersion<V extends VersionEntry>(item: Versioned<V>, before: V, force = false): boolean {
  const last = item.versions?.at(-1);
  const merge = !force && !item.sealed && last && Date.parse(before.at) - Date.parse(last.at) <= MERGE_MS;
  if (force) item.sealed = true;
  else delete item.sealed;
  if (merge) return false;
  const ver = versionNumber(item);
  item.versions = [...(item.versions ?? []), { ...before, ver }].slice(-MAX_VERSIONS);
  item.ver = ver + 1;
  return true;
}
