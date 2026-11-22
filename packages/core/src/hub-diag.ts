/**
 * The hub's diagnostics on this PC: `GET /api/diag` gives the hub's in-memory ring of recent problems (apps/hub/src/diag.ts),
 * and this keeps a copy in the logs folder as `hub-diag.json` (overwritten, the last {@link HUB_DIAG_KEEP} entries; an
 * object that slept starts an empty ring, so older entries are merged in) plus one `main.log` line with the newest error.
 * That lets the hub's problems be read without the Cloudflare dashboard.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How many entries the file keeps. */
export const HUB_DIAG_KEEP = 200;

/** One entry of the hub's ring (loosely typed: a newer hub may add fields). */
export interface HubDiagEntry {
  at: string;
  kind: string;
  where: string;
  method?: string;
  path?: string;
  status?: number;
  code?: string;
  message?: string;
  stack?: string[];
  ms?: number;
  count?: number;
}

/** What `GET /api/diag` answers. */
export interface HubDiagSnapshot {
  now: string;
  startedAt: string;
  total: number;
  entries: HubDiagEntry[];
}

/** What `hub-diag.json` holds. */
export interface HubDiagFile {
  /** When this PC saved it, and why (`connect failed`, `every 10 minutes`). */
  savedAt: string;
  reason: string;
  /** The hub's clock and wake-up time in the last answer. */
  hubNow: string;
  hubStartedAt: string;
  entries: HubDiagEntry[];
}

/**
 * Reads a `/api/diag` answer defensively (anything else is undefined).
 *
 * @param data - The parsed JSON.
 * @returns The snapshot, or undefined when it is not one.
 */
export function parseHubDiag(data: unknown): HubDiagSnapshot | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.entries)) return undefined;
  const entries = (d.entries as unknown[]).filter((e): e is HubDiagEntry => !!e && typeof e === "object" && typeof (e as HubDiagEntry).at === "string" && typeof (e as HubDiagEntry).where === "string");
  return { now: typeof d.now === "string" ? d.now : "", startedAt: typeof d.startedAt === "string" ? d.startedAt : "", total: typeof d.total === "number" ? d.total : entries.length, entries };
}

/** An entry's identity, to merge the same one seen twice (its time and count move on while it repeats, so they are not part of it). */
const keyOf = (e: HubDiagEntry): string => [e.kind, e.where, e.method, e.path, e.status, e.code, e.message].join("|");

/**
 * Merges the entries kept so far with the hub's current ones: the same entry once (the later sighting), oldest first, the last
 * {@link HUB_DIAG_KEEP}.
 *
 * @param kept - Entries already in the file.
 * @param fresh - The hub's ring now.
 * @returns The merged list.
 */
export function mergeDiagEntries(kept: readonly HubDiagEntry[], fresh: readonly HubDiagEntry[]): HubDiagEntry[] {
  const map = new Map<string, HubDiagEntry>();
  for (const e of [...kept, ...fresh]) {
    const old = map.get(keyOf(e));
    if (!old || old.at <= e.at) map.set(keyOf(e), e);
  }
  return [...map.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-HUB_DIAG_KEEP);
}

/**
 * The newest error as one short log line (undefined when the ring has none): when, what was called, the status, the code
 * and the message.
 *
 * @param entries - The entries, oldest first.
 * @returns The line, e.g. `hub-diag newest 2026-11-22T10:00:00Z POST /api/ticket 500 hub-internal: boom`.
 */
export function newestDiagLine(entries: readonly HubDiagEntry[]): string | undefined {
  const e = entries[entries.length - 1];
  if (!e) return undefined;
  const what = [e.method, e.path ?? e.where, e.status].filter((x) => x !== undefined).join(" ");
  return `hub-diag newest ${e.at} ${what}${e.code ? ` ${e.code}` : ""}${e.message ? `: ${e.message}` : ""}`.slice(0, 400);
}

/**
 * Saves the hub's diagnostics into the logs folder: `hub-diag.json` (merged, last 200) and one line in `main.log`.
 * Never throws (a log that cannot be written never stops the app).
 *
 * @param logsDir - The KesherAI logs folder.
 * @param snap - The hub's answer.
 * @param reason - Why it was fetched.
 * @param now - The time in ms.
 * @returns The newest error's line (logged to `main.log` when it is new since the last save), if any.
 */
export function saveHubDiag(logsDir: string, snap: HubDiagSnapshot, reason: string, now = Date.now()): string | undefined {
  try {
    mkdirSync(logsDir, { recursive: true });
    const file = join(logsDir, "hub-diag.json");
    let kept: HubDiagEntry[] = [];
    try {
      kept = (JSON.parse(readFileSync(file, "utf8")) as Partial<HubDiagFile>).entries ?? [];
    } catch {
      // No file yet, or a damaged one: start again.
    }
    const entries = mergeDiagEntries(Array.isArray(kept) ? kept : [], snap.entries);
    const out: HubDiagFile = { savedAt: new Date(now).toISOString(), reason, hubNow: snap.now, hubStartedAt: snap.startedAt, entries };
    writeFileSync(file, JSON.stringify(out, null, 2));
    // A line only when something new happened since the last save (not the same old error every 10 minutes).
    const was = kept[kept.length - 1];
    const now1 = entries[entries.length - 1];
    const line = newestDiagLine(entries);
    if (line && (was?.at !== now1?.at || was?.count !== now1?.count)) appendFileSync(join(logsDir, "main.log"), `${new Date(now).toISOString()} ${line}\n`);
    return line;
  } catch {
    return undefined;
  }
}
