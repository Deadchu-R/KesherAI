import { createHash } from "node:crypto";
import type { DriveSync, SyncTaskBody, WorkListItem } from "@kesher/shared";

/**
 * Claude's work list on every device (part of "Tasks on all your devices", tasks-sync.ts): the PC reads
 * `docs/WORK_LIST.md` from git (inbox-runner.ts `workList`), and writes each item as a sealed `task` record with
 * origin `work-list` to the owner's Google Drive. This PC is the only writer of these records; an item is written
 * again only when it changed, and an item that left the list gets a tombstone.
 */

/** How often the work list is read again while tasks sync is on. */
export const WORK_LIST_EVERY_MS = 15 * 60_000;

/** What is remembered of one written item (in the tasks-sync state file). */
export interface WorkListSent {
  /** The record id (the item's id, or the item's id with `-r<n>` when an older record of it was deleted). */
  rid: string;
  /** A hash of the body last written. */
  fp: string;
  /** When it was first written (ISO), kept so a rewrite does not change it. */
  createdAt: string;
}

/** Item id -> what was written for it. */
export type WorkListSentMap = Record<string, WorkListSent>;

/** What one run did. */
export interface WorkListSyncResult {
  written: number;
  removed: number;
}

/** The record body of one item. */
function bodyOf(item: WorkListItem, createdAt: string, scrub: (s: string) => string): SyncTaskBody {
  return {
    type: "task",
    title: scrub(item.title).slice(0, 200),
    spec: scrub(item.text).slice(0, 8000),
    origin: "work-list",
    executor: "claude",
    createdAt,
    workList: { section: scrub(item.section).slice(0, 200), status: item.status, order: item.order },
  };
}

/** A record id for an item that is not tombstoned in Drive (a deleted facet can never be written again). */
function freeId(sync: DriveSync, itemId: string): string {
  const dead = new Set(sync.records().filter((r) => r.head.kind === "task" && r.head.deleted).map((r) => r.head.id));
  if (!dead.has(itemId)) return itemId;
  for (let n = 2; ; n++) if (!dead.has(`${itemId}-r${n}`)) return `${itemId}-r${n}`;
}

/**
 * Brings Drive in line with the work list: writes new and changed items, tombstones items that left it. With
 * `items` set to "off" (the user hid the work list) every written item is tombstoned.
 *
 * @param sync - The device's Drive sync (records go through its outbox).
 * @param sent - What was written before; changed in place.
 * @param items - The parsed list, or "off".
 * @param opts - The clock, the text scrubber (home folder and user names) and the log.
 * @returns How many items were written and removed.
 */
export async function syncWorkList(
  sync: DriveSync,
  sent: WorkListSentMap,
  items: readonly WorkListItem[] | "off",
  opts: { now: number; scrub: (s: string) => string; log?: (m: string) => void },
): Promise<WorkListSyncResult> {
  const res: WorkListSyncResult = { written: 0, removed: 0 };
  const keep = new Set(items === "off" ? [] : items.map((i) => i.id));
  for (const [id, s] of Object.entries(sent)) {
    if (keep.has(id)) continue;
    try {
      await sync.write("task", s.rid, null);
      res.removed++;
    } catch (e) {
      // Already deleted (or another PC's record): nothing left to remove.
      opts.log?.(`Work list: an item was not removed (${String((e as Error).message).slice(0, 80)}).`);
    }
    delete sent[id];
  }
  if (items === "off") return res;
  for (const item of items) {
    const prev = sent[item.id];
    const fp = createHash("sha256").update(JSON.stringify(bodyOf(item, "", opts.scrub))).digest("base64url").slice(0, 22);
    if (prev?.fp === fp) continue;
    const live = !!prev && sync.records().some((r) => r.head.kind === "task" && r.head.id === prev.rid && !r.head.deleted);
    const rid = live ? prev.rid : freeId(sync, item.id);
    const createdAt = live ? prev.createdAt : new Date(opts.now).toISOString();
    try {
      await sync.write("task", rid, bodyOf(item, createdAt, opts.scrub));
      sent[item.id] = { rid, fp, createdAt };
      res.written++;
    } catch (e) {
      // Another PC writes this list too (records are single-writer): leave its copy alone, and never delete it.
      opts.log?.(`Work list: an item was not written (${String((e as Error).message).slice(0, 80)}).`);
    }
  }
  return res;
}
