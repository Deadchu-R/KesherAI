/**
 * The tasks and agent snapshots kept in the owner's Google Drive, as the hub page shows them (docs/RESEARCH_LOG.md,
 * "Tasks in Roee's Google Drive instead of the hub", step 4). Pure functions (no DOM, no network), so they are tested
 * in Node (apps/hub/src/drive-view.test.ts); drive.ts does the syncing, app.ts and agents.ts draw.
 *
 * Record rules this page keeps (packages/core/src/tasks-sync.ts has the PC's side):
 * - The page writes only `task` records (origin `page`), never `run` records: only the device that runs a task writes
 *   its run. Tasks still travel through the hub's sealed relay, so the page's records carry `target: "hub:<device id>"`
 *   (or `hub:hub` for Claude cloud), which no PC's Drive writer id matches: a PC never queues them a second time from
 *   Drive.
 * - A PC that queues a relayed Antigravity task in its inbox writes its own record for it, with the id
 *   `h-<slug of the task id>` ({@link hubInboxId}); the list folds that copy into the page's row.
 */
import type { StoredRecord } from "../../../packages/shared/src/drive-sync.js";
import type { SyncAgentBody, SyncAgentSource, SyncMetaBody, SyncOrigin, SyncRunBody, SyncTaskBody } from "../../../packages/shared/src/hub-sync.js";
import type { HubExecutor } from "../../../packages/shared/src/hub-protocol.js";
import type { PageTask, TaskStatus } from "./device.js";

/** A short text in both languages. */
export interface Words {
  he: string;
  en: string;
}

/** Where a row of the task list is kept in Drive (set on every row Drive knows). */
export interface DriveMark {
  /** The device that wrote the task, in words. */
  device: Words;
  /** The Drive writer id of that device. */
  writer: string;
  /** Who made the task (the phone, the PC's inbox, Claude, self-work, this page). */
  origin: SyncOrigin;
  /** The row exists only in Drive (another device's task): nothing here can resend or cancel it. */
  only: boolean;
}

/** What the merge needs from the page. */
export interface DriveViewContext {
  /** This page's Drive writer id. */
  me: string;
  /** The names of the owner's paired PCs (hub presence), to name a PC writer when there is only one. */
  pcNames: string[];
  /** A hub device's name by its hub id (for the page's `hub:<id>` targets). */
  deviceName: (hubId: string) => string | undefined;
}

/** An agent run's last snapshot from Drive (the Agents tab's "last seen" cards while the PCs are off). */
export interface SyncedAgent {
  id: string;
  device: Words;
  body: SyncAgentBody;
}

const ID_RE = /^[\w-]{8,64}$/;

/**
 * The record id a PC gives a relayed task it queued in its inbox: `h-` and the task id's slug (as `slugOf` in
 * packages/core/src/task-inbox.ts makes it: lower case, runs of other characters become one dash, 30 characters).
 *
 * @param taskId - The page's task id.
 * @returns The PC's record id for it.
 */
export function hubInboxId(taskId: string): string {
  const slug = taskId.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "") || "task";
  return `h-${slug}`;
}

/**
 * Names the device that wrote a record.
 *
 * @param writer - The Drive writer id (`pc-…`, `page-…`, `phone-…`).
 * @param ctx - This page's writer id and the PCs' names.
 * @returns The device in both languages.
 */
export function deviceLabel(writer: string, ctx: Pick<DriveViewContext, "me" | "pcNames">): Words {
  if (writer === ctx.me) return { he: "המכשיר הזה", en: "This device" };
  if (writer.startsWith("pc-")) return ctx.pcNames.length === 1 ? { he: ctx.pcNames[0]!, en: ctx.pcNames[0]! } : { he: "מחשב", en: "PC" };
  if (writer.startsWith("page-")) return { he: "דף המרכז", en: "Hub page" };
  if (writer.startsWith("phone-")) return { he: "טלפון", en: "Phone" };
  return { he: "מכשיר", en: "Device" };
}

/** A synced executor (a hub executor or an inbox one) as the page's executor and route. */
function routeOf(executor: string): { executor: HubExecutor; route: PageTask["route"] } {
  switch (executor) {
    case "claude-cloud":
    case "claude":
      return { executor: "claude-cloud", route: "claude-cloud" };
    case "pc-local":
    case "local":
      return { executor: "pc-local", route: "pc" };
    case "pc-antigravity":
    case "antigravity":
      return { executor: "pc-antigravity", route: "pc" };
    case "auto":
      return { executor: "auto", route: "pc" };
    default:
      return { executor: "pc-any", route: "pc" };
  }
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(["done", "partial", "failed", "blocked", "cancelled"]);

/** A time as ms (an ISO string from a record), or the fallback. */
const ms = (iso: string | undefined, fallback: number): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : fallback;
};

/** A run's state and text onto a row. */
function applyRun(t: PageTask, run: SyncRunBody): void {
  t.status = run.state;
  const line = run.result ?? run.status;
  if (line) t.line = line;
  if (run.branch) t.branch = run.branch;
  if (run.link) t.link = run.link;
}

/**
 * The task list: this page's own tasks (kept here, with their live relay state) and every task in Drive from every
 * device, newest first. A task known both ways is one row (the local one, marked with where Drive has it); a PC's
 * copy of a relayed task is folded into the page's row; deleted and archived tasks are left out.
 *
 * @param local - The tasks this page keeps (sent from here, or reported by a PC over the relay).
 * @param records - The records this page has from Drive (winning revisions).
 * @param ctx - This page's writer id and how to name devices.
 * @returns The rows to show.
 */
export function mergeTasks(local: readonly PageTask[], records: readonly StoredRecord[], ctx: DriveViewContext): PageTask[] {
  const tasks = new Map<string, { writer: string; body: SyncTaskBody }>();
  const runs = new Map<string, SyncRunBody>();
  const hidden = new Set<string>();
  for (const r of records) {
    if (r.head.deleted || !r.body) continue;
    if (r.head.kind === "task") tasks.set(r.head.id, { writer: r.head.writer, body: r.body as SyncTaskBody });
    else if (r.head.kind === "run") runs.set(r.head.id, r.body as SyncRunBody);
    else if (r.head.kind === "meta" && (r.body as SyncMetaBody).archived) hidden.add(r.head.id);
  }
  const mark = (id: string, only: boolean): DriveMark | undefined => {
    const t = tasks.get(id);
    return t ? { device: deviceLabel(t.writer, ctx), writer: t.writer, origin: t.body.origin, only } : undefined;
  };
  const out: PageTask[] = [];
  const used = new Set<string>();
  for (const l of local) {
    const row: PageTask = { ...l, history: l.history };
    const m = mark(l.taskId, false);
    if (m) row.drive = m;
    used.add(l.taskId);
    // The PC's inbox copy of a task this page relayed: its run is the newest word on it.
    if (!l.inbox) {
      const copy = hubInboxId(l.taskId);
      if (tasks.has(copy)) {
        used.add(copy);
        const run = runs.get(copy) ?? runs.get(l.taskId);
        if (run && !TERMINAL.has(row.status)) applyRun(row, run);
      }
    }
    if (!hidden.has(l.taskId)) out.push(row);
  }
  for (const [id, { writer, body }] of tasks) {
    if (used.has(id) || hidden.has(id)) continue;
    const { executor, route } = routeOf(body.executor);
    const target = body.target ?? "";
    const toName = target.startsWith("hub:")
      ? target === "hub:hub"
        ? "Claude cloud"
        : (ctx.deviceName(target.slice(4)) ?? "PC")
      : target
        ? deviceLabel(target, { pcNames: ctx.pcNames, me: "" }).en
        : "PC";
    const createdAt = ms(body.createdAt, 0);
    const row: PageTask = {
      taskId: id,
      title: body.title,
      spec: body.spec,
      executor,
      ifOffline: "wait",
      route,
      to: null,
      toName,
      createdAt,
      status: "waiting",
      history: [],
      drive: { device: deviceLabel(writer, ctx), writer, origin: body.origin, only: true },
    };
    const run = runs.get(id);
    if (run) {
      applyRun(row, run);
      if (run.startedAt) row.history.push({ t: ms(run.startedAt, createdAt), he: "התחיל", en: "Started" });
      if (run.endedAt) row.history.push({ t: ms(run.endedAt, createdAt), he: "הסתיים", en: "Ended" });
    }
    out.push(row);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The task record this page writes for a task it sent (and, once, for each task it kept before Drive was on).
 * Tasks a PC reported over the relay are the PC's to write, and ids Drive cannot hold are skipped.
 *
 * @param t - A task this page keeps.
 * @returns The record body, or undefined when this page must not write one.
 */
export function pageTaskBody(t: PageTask): SyncTaskBody | undefined {
  if (t.inbox || t.drive?.only || !ID_RE.test(t.taskId)) return undefined;
  return {
    type: "task",
    title: t.title.slice(0, 200),
    spec: t.spec.slice(0, 8000),
    origin: "page",
    executor: t.executor,
    target: `hub:${t.to ?? "none"}`.slice(0, 64),
    createdAt: new Date(t.createdAt).toISOString(),
  };
}

/**
 * The newest agent snapshots in Drive (one per run), newest first.
 *
 * @param records - The records this page has from Drive.
 * @param ctx - This page's writer id and the PCs' names.
 * @param max - At most this many.
 * @returns The snapshots.
 */
export function agentSnapshots(records: readonly StoredRecord[], ctx: Pick<DriveViewContext, "me" | "pcNames">, max = 30): SyncedAgent[] {
  const end = (a: SyncAgentBody) => ms(a.endedAt ?? a.updatedAt ?? a.startedAt, 0);
  return records
    .filter((r) => r.head.kind === "agent" && !r.head.deleted && r.body)
    .map((r) => ({ id: r.head.id, device: deviceLabel(r.head.writer, ctx), body: r.body as SyncAgentBody }))
    .sort((a, b) => end(b.body) - end(a.body))
    .slice(0, max);
}

/** The agent sources of a snapshot, in words with an icon. */
export const SNAPSHOT_SOURCE: Record<SyncAgentSource, Words & { icon: string }> = {
  "chat-helper": { icon: "🤖", he: "סוכן עוזר בצ׳אט", en: "Chat helper" },
  inbox: { icon: "📥", he: "תיבת משימות", en: "Task inbox" },
  antigravity: { icon: "✦", he: "Antigravity", en: "Antigravity" },
  "claude-cloud": { icon: "✷", he: "Claude בענן", en: "Claude cloud" },
  "claude-chat": { icon: "💬", he: "צ׳אט Claude", en: "Claude chat" },
};

/** A Google access token handed to the page by the KesherAI phone app. */
export interface AppToken {
  token: string;
  /** When it ends (ms since epoch). */
  expiresAt: number;
}

/**
 * Reads a Drive access token the KesherAI phone app put in the address's fragment (`#kdt=<token>&kde=<seconds>`;
 * a fragment is never sent to a server). Anything else is refused.
 *
 * @param hash - `location.hash`.
 * @param now - The clock (ms).
 * @returns The token and when it ends, or undefined.
 */
export function parseAppToken(hash: string, now: number): AppToken | undefined {
  if (!hash.startsWith("#kdt=")) return undefined;
  const q = new URLSearchParams(hash.slice(1));
  const token = q.get("kdt") ?? "";
  const secs = Number(q.get("kde"));
  if (!/^[\w.~-]{20,4096}$/.test(token) || !Number.isInteger(secs) || secs < 60 || secs > 3600) return undefined;
  return { token, expiresAt: now + secs * 1000 };
}
