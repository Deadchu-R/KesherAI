/** Notifications that follow each other from the same place, shown as one line with a count (the bell panel). */

/** The fields grouping needs (a notification from /api/inbox). */
export interface GroupableNote {
  title: string;
  path?: string;
  at: number;
  resolved?: string;
}

/**
 * Joins notes in a row that have the same title and the same place into the first (newest) of them.
 *
 * @param notes - Newest first, as the inbox sends them.
 * @returns Each group's newest note with `count` (1 when alone). A note that was answered never joins one that was not.
 */
export function groupNotes<T extends GroupableNote>(notes: T[]): Array<T & { count: number }> {
  const out: Array<T & { count: number }> = [];
  for (const n of notes) {
    const last = out[out.length - 1];
    if (last && last.title === n.title && (last.path ?? "") === (n.path ?? "") && Boolean(last.resolved) === Boolean(n.resolved)) last.count++;
    else out.push({ ...n, count: 1 });
  }
  return out;
}
