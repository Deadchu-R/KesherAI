/**
 * Merging a canvas the user is drawing on with the one saved on the server (where the model's changes are), the way
 * Excalidraw's own collaboration does: per element id, the higher `version` wins (the server's on a tie, so a change
 * the model made at the same version as a local one still shows); elements only on one side are kept in their order.
 */

/** The fields of an Excalidraw element the merge reads. */
export interface Versioned {
  id: string;
  version?: number;
  versionNonce?: number;
}

/**
 * @param local - The page's elements (including deleted ones, as Excalidraw keeps them).
 * @param remote - The server's elements.
 * @returns The merged list: local order first, then elements only the server has.
 */
export function mergeElements<T extends Versioned>(local: readonly T[], remote: readonly T[]): T[] {
  const theirs = new Map(remote.map((e) => [e.id, e]));
  const out = local.map((mine) => {
    const other = theirs.get(mine.id);
    if (!other) return mine;
    theirs.delete(mine.id);
    return (other.version ?? 0) >= (mine.version ?? 0) ? other : mine;
  });
  for (const e of remote) if (theirs.has(e.id)) out.push(e);
  return out;
}

/**
 * A cheap fingerprint of a scene, to skip saving when nothing changed (Excalidraw calls onChange on every pointer move).
 *
 * @param els - The elements.
 * @returns The sum of their versions and their count.
 */
export function sceneKey(els: readonly Versioned[]): string {
  let sum = 0;
  for (const e of els) sum += e.version ?? 0;
  return `${els.length}:${sum}`;
}
