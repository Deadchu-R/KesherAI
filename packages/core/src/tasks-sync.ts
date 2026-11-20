import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import {
  DriveError,
  DriveRest,
  DriveSync,
  ensureAccountKey,
  SYNC_LIMITS,
  TERMINAL_RUN_STATES,
  type DriveStore,
  type DriveSyncState,
  type DriveTokenGetter,
  type InboxTaskView,
  type SyncAgentBody,
  type SyncOrigin,
  type SyncRunBody,
  type SyncRunState,
  type SyncTaskBody,
} from "@kesher/shared";
import type { RunSnapshot } from "./agent-activity.js";

/**
 * "Tasks on all your devices" on the PC (docs/RESEARCH_LOG.md, "Tasks in Roee's Google Drive instead of the hub",
 * step 3): the task inbox's tasks and their runs are written as sealed records to the hidden KesherAI folder
 * (`appDataFolder`) of the user's own Google Drive, and tasks the phone or the hub page wrote there are pulled into
 * the inbox (once each). Off until the user turns it on, on this PC.
 *
 * It also writes an `agent` snapshot of each agent run on this PC (chat helpers on a local or cloud model,
 * Antigravity): when it starts, every few minutes while it goes, and when it ends, so the hub page can show "last
 * seen" cards while the PC is off (step 5). After a sync that wrote something it asks the hub to send the other
 * devices a bare `sync` ping, and a ping from them makes it pull within seconds instead of at the next timer.
 *
 * The private state (opened records, the changes cursor, what was sent) is kept in a file in the data folder, never
 * in git or logs; Google tokens never pass through here except to the Drive store.
 */

/** How often it syncs while on (it also syncs soon after each change of the inbox). */
export const TASKS_SYNC_EVERY_MS = 3 * 60_000;
/** Compaction (deleting old revisions) runs at most this often. */
const COMPACT_EVERY_MS = 6 * 3600_000;
/** The longest wait after failures in a row. */
const MAX_BACKOFF_MS = 30 * 60_000;
/** A change of the inbox is synced after this quiet time (several changes become one sync). */
const DEBOUNCE_MS = 5_000;
/** Finished inbox tasks older than this are not written (Drive would compact them right away). */
const KEEP_FINISHED_MS = 90 * 24 * 3600_000;
/** Agent runs followed at once (the oldest seen is dropped beyond this; a run that never ends cannot grow it). */
const AGENTS_MAX = 50;
/** States of a going agent run. */
const AGENT_GOING = new Set<RunSnapshot["state"]>(["queued", "running", "waiting"]);

/** What the service needs from the Google sign-in (google.ts). */
export interface TasksSyncGoogle {
  readonly connected: boolean;
  /** Whether the `sync` service (scope `drive.appdata`) was granted. */
  has(service: "sync"): boolean;
  accessToken(opts: { refresh: boolean }): Promise<string>;
}

/** What the service needs from the task inbox (inbox-runner.ts). */
export interface TasksSyncInbox {
  list(): Promise<InboxTaskView[]>;
  fromDrive(t: { id: string; title: string; goal: string; executor: string }): Promise<boolean>;
  onChange(cb: () => void): () => void;
}

/** Options of {@link TasksSync}. */
export interface TasksSyncDeps {
  /** The `tasksSync` settings (config.json). */
  settings: () => { enabled: boolean };
  /** Turns it on or off in the settings and saves them. */
  setEnabled: (on: boolean) => Promise<void>;
  google: TasksSyncGoogle;
  inbox: TasksSyncInbox;
  /** The state file, in the data folder (e.g. `tasks-sync.json`). */
  file: string;
  /** Makes the Drive store (tests pass a fake). */
  drive?: (token: DriveTokenGetter) => DriveStore;
  /** Short notes for the server log (never tokens or task text). */
  log?: (message: string) => void;
  now?: () => number;
  /** The home folder, scrubbed from task text before it is sealed. */
  home?: string;
  /** A sync wrote to Drive: tell the other devices (the hub's bare `sync` ping, hub-client.ts). */
  onWrote?: () => void;
}

/** The status the Settings section shows (`GET /api/tasks-sync`). */
export interface TasksSyncStatus {
  enabled: boolean;
  /** Signed in to Google on this PC. */
  connected: boolean;
  /** Signed in, but the Drive app-folder permission is missing (or Google refused the token): "Reconnect Google". */
  needsReconnect: boolean;
  syncing: boolean;
  /** ISO time of the last sync that went through. */
  lastSync: string | null;
  /** The last error, short (no task text, no tokens). */
  lastError: string | null;
  counts: {
    /** Tasks in Drive (live task records). */
    tasks: number;
    /** Writes waiting to reach Drive. */
    pending: number;
    /** Tasks brought into the inbox from other devices. */
    received: number;
  };
}

/** What is saved between runs. */
interface Saved {
  /** This PC's writer id in the records. */
  writer: string;
  sync?: DriveSyncState;
  /** Inbox task id -> a hash of the last run body written for it. */
  sent: Record<string, string>;
  /** Inbox task id -> the record id of a task that came from Drive. */
  received: Record<string, string>;
  lastSync?: string;
  lastError?: string;
  lastCompact?: number;
  needsReconnect?: boolean;
}

const ID_RE = /^[\w-]{8,64}$/;

/**
 * The record id for an inbox task written by this PC: the inbox id when it fits, else a stable hash of it.
 *
 * @param inboxId - The task inbox id.
 */
export function syncIdFor(inboxId: string): string {
  return ID_RE.test(inboxId) ? inboxId : `i-${createHash("sha256").update(inboxId).digest("hex").slice(0, 20)}`;
}

/**
 * The inbox id for a task that came from Drive: `g-` and a hash of its record id (stable, so it is queued once).
 *
 * @param syncId - The record id.
 */
export function inboxIdFor(syncId: string): string {
  return `g-${createHash("sha256").update(syncId).digest("hex").slice(0, 16)}`;
}

/**
 * Removes the home folder and user names in common profile paths from text about to be sealed.
 *
 * @param text - Task text.
 * @param home - The home folder.
 */
export function scrubText(text: string, home = homedir()): string {
  let t = text;
  if (home && home.length > 3) t = t.split(home).join("~").split(home.replace(/\\/g, "/")).join("~");
  return t.replace(/\b([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi, "$1~").replace(/(\/(?:home|Users)\/)[^/\s"']+/g, "$1~");
}

const ORIGIN: Record<InboxTaskView["from"], SyncOrigin> = { claude: "inbox-claude", roee: "inbox-roee", "self-work": "self-work", hub: "page" };

/** The inbox's state as a synced run state. */
function runState(t: InboxTaskView): SyncRunState {
  switch (t.status) {
    case "waiting":
      return t.runBy === "antigravity" ? "waiting-run" : "waiting";
    case "queued":
    case "deferred-quota":
      return "waiting";
    case "running":
    case "needs-approval":
      return "running";
    case "done":
      return "done";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    case "declined":
      return "blocked";
    case "skipped":
      return "cancelled";
  }
}

const iso = (ms: number | undefined): string | undefined => (ms ? new Date(ms).toISOString() : undefined);
const hash = (x: unknown): string => createHash("sha256").update(JSON.stringify(x)).digest("base64url").slice(0, 22);

/** A short, safe text for an error (never the token; Drive errors carry only status and reason). */
function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\b(Bearer|token|access_token|refresh_token)([=: ]+)[^\s&"']{4,}/gi, "$1$2…").slice(0, 200);
}

/** Whether an error means the Google permission is missing or no longer works (the user must reconnect). */
function needsReconnect(e: unknown): boolean {
  if (e instanceof DriveError) return e.status === 401 || (e.status === 403 && /insufficient|scope|permission|forbidden/i.test(e.reason));
  return /invalid_grant|Not connected|unauthorized_client/i.test(e instanceof Error ? e.message : "");
}

/**
 * Keeps the task inbox and the user's Google Drive in step (see the file comment). Call {@link TasksSync.start} once;
 * it does nothing until the user turns it on.
 */
export class TasksSync {
  private saved: Saved = { writer: "", sent: {}, received: {} };
  private loaded = false;
  private sync?: DriveSync;
  private running?: Promise<TasksSyncStatus>;
  private timer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private saving: Promise<void> = Promise.resolve();
  private stopInbox?: () => void;
  /** Agent runs to snapshot, by run id: the newest look, and when (and what) was last written. */
  private readonly agents = new Map<string, { snap: RunSnapshot; summary?: string; sentAt?: number; sentFp?: string }>();
  /** Something was written to Drive during the current sync (the others get a ping). */
  private wrote = false;

  /** @param d - What it needs from KesherAI. */
  constructor(private readonly d: TasksSyncDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private get enabled(): boolean {
    return this.d.settings().enabled;
  }

  private get ready(): boolean {
    return this.enabled && this.d.google.connected && this.d.google.has("sync");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.d.file, "utf8")) as Partial<Saved>;
      this.saved = { ...raw, writer: typeof raw.writer === "string" && /^[\w-]{1,64}$/.test(raw.writer) ? raw.writer : "", sent: raw.sent ?? {}, received: raw.received ?? {} };
    } catch {
      this.saved = { writer: "", sent: {}, received: {} };
    }
    if (!this.saved.writer) this.saved.writer = `pc-${randomBytes(9).toString("base64url")}`;
  }

  /** Writes the state file (owner-only, one write at a time, write then rename). */
  private persist(): Promise<void> {
    const body = JSON.stringify(this.saved);
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.d.file), { recursive: true });
        const tmp = `${this.d.file}.${process.pid}.tmp`;
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, this.d.file);
      })
      .catch(() => undefined);
    return this.saving;
  }

  /**
   * The status for Settings.
   *
   * @returns On/off, connection, last sync and counts.
   */
  async status(): Promise<TasksSyncStatus> {
    await this.load();
    const recs = this.sync?.records() ?? Object.values(this.saved.sync?.records ?? {});
    return {
      enabled: this.enabled,
      connected: this.d.google.connected,
      needsReconnect: this.d.google.connected && (!this.d.google.has("sync") || !!this.saved.needsReconnect),
      syncing: !!this.running,
      lastSync: this.saved.lastSync ?? null,
      lastError: this.saved.lastError ?? null,
      counts: {
        tasks: recs.filter((r) => r.head.kind === "task" && !r.head.deleted).length,
        pending: (this.sync?.state ?? this.saved.sync)?.outbox.length ?? 0,
        received: Object.keys(this.saved.received).length,
      },
    };
  }

  /** Starts following the inbox and the timer (syncs only while turned on). */
  start(): void {
    this.stopInbox ??= this.d.inbox.onChange(() => this.schedule(DEBOUNCE_MS));
    this.schedule(DEBOUNCE_MS);
  }

  /** Stops the timer and the inbox listener. */
  stop(): void {
    this.stopInbox?.();
    this.stopInbox = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * One agent run as it is now (agent-activity.ts makes the snapshot). Only runs seen going are followed; its
   * snapshot is written at the next sync when it is new, when it ended (a sync then comes in 5 seconds) or when
   * {@link SYNC_LIMITS.agentWriteEveryMs} passed with a change.
   *
   * @param s - The run.
   * @param summary - A short result line, when the run has one (scrubbed and cut here).
   */
  observeAgent(s: RunSnapshot, summary?: string): void {
    if (!this.ready) return void this.agents.clear();
    const known = this.agents.get(s.runId);
    if (!known && !AGENT_GOING.has(s.state)) return;
    this.agents.delete(s.runId);
    this.agents.set(s.runId, { ...known, snap: s, ...(summary ? { summary } : {}) });
    if (this.agents.size > AGENTS_MAX) this.agents.delete(this.agents.keys().next().value!);
    if (!known || !AGENT_GOING.has(s.state)) this.soon(DEBOUNCE_MS);
  }

  /**
   * Another device wrote to Drive (its `sync` ping came through the hub): pull in a moment, or right after the sync
   * that is running now.
   */
  onPing(): void {
    if (this.ready && this.stopInbox) this.soon(SYNC_LIMITS.pingPullDelayMs);
  }

  /** A sync in `ms`, counted from the end of the one running now (a sync already going may have missed the news). */
  private soon(ms: number): void {
    if (this.running) void this.running.finally(() => this.schedule(ms));
    else this.schedule(ms);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.syncNow().finally(() => {
        if (!this.timer && this.stopInbox) this.schedule(this.failures ? Math.min(MAX_BACKOFF_MS, TASKS_SYNC_EVERY_MS * 2 ** (this.failures - 1)) : TASKS_SYNC_EVERY_MS);
      });
    }, ms);
    this.timer.unref?.();
  }

  /**
   * Turns it on or off. Turning on needs the Google permission (the route sends the user to Google when it is
   * missing); turning off keeps what is in Drive.
   *
   * @param on - On or off.
   * @returns The status after the change.
   */
  async setEnabled(on: boolean): Promise<TasksSyncStatus> {
    await this.d.setEnabled(on);
    if (!on) this.sync = undefined;
    else void this.syncNow();
    return this.status();
  }

  /**
   * Syncs now (once at a time; a call while one runs waits for it).
   *
   * @returns The status after it.
   */
  syncNow(): Promise<TasksSyncStatus> {
    this.running ??= this.doSync().finally(() => (this.running = undefined));
    return this.running;
  }

  private async doSync(): Promise<TasksSyncStatus> {
    await this.load();
    if (!this.ready) return this.status();
    this.wrote = false;
    try {
      const sync = await this.open();
      await sync.pull();
      await this.receive(sync);
      await this.send(sync);
      await this.sendAgents(sync);
      const flushed = await sync.flush();
      if (flushed.sent) this.wrote = true;
      if (flushed.error) throw flushed.error;
      if (this.now() - (this.saved.lastCompact ?? 0) >= COMPACT_EVERY_MS) {
        await sync.compact(50);
        this.saved.lastCompact = this.now();
      }
      this.saved.lastSync = new Date(this.now()).toISOString();
      delete this.saved.lastError;
      delete this.saved.needsReconnect;
      this.failures = 0;
      if (this.wrote) this.d.onWrote?.();
    } catch (e) {
      this.failures++;
      this.saved.lastError = errorText(e);
      if (needsReconnect(e)) this.saved.needsReconnect = true;
      this.d.log?.(`Tasks sync: ${this.saved.lastError}`);
    }
    this.saved.sync = this.sync?.state ?? this.saved.sync;
    await this.persist();
    return this.status();
  }

  /** The device's sync (reads the account key from Drive once per run of KesherAI). */
  private async open(): Promise<DriveSync> {
    if (this.sync) return this.sync;
    const token: DriveTokenGetter = (o) => this.d.google.accessToken(o);
    const drive = (this.d.drive ?? ((t) => new DriveRest({ token: t })))(token);
    const keys = await ensureAccountKey(drive);
    this.sync = await DriveSync.create({
      drive,
      writer: this.saved.writer,
      keys,
      ...(this.saved.sync ? { state: this.saved.sync } : {}),
      save: (state) => {
        this.saved.sync = state;
        return this.persist();
      },
      onWarn: (m) => this.d.log?.(`Tasks sync: ${m}`),
      now: () => this.now(),
    });
    return this.sync;
  }

  /** Queues tasks other devices wrote (meant for any device or this one, not finished, not already queued). */
  private async receive(sync: DriveSync): Promise<void> {
    const runs = new Map(sync.records().filter((r) => r.head.kind === "run").map((r) => [r.head.id, r]));
    const known = new Set(Object.values(this.saved.received));
    for (const r of sync.records()) {
      if (r.head.kind !== "task" || r.head.deleted || r.head.writer === this.saved.writer || known.has(r.head.id)) continue;
      const body = r.body as SyncTaskBody | null;
      if (!body || (body.origin !== "phone" && body.origin !== "page")) continue;
      if (body.target && body.target !== this.saved.writer) continue;
      const run = runs.get(r.head.id)?.body as SyncRunBody | null | undefined;
      if (run && (TERMINAL_RUN_STATES.has(run.state) || run.state === "running")) continue;
      const id = inboxIdFor(r.head.id);
      await this.d.inbox.fromDrive({ id, title: body.title, goal: body.spec, executor: body.executor });
      // Remembered even when the inbox refused it (a bad task stays out instead of being retried every sync).
      this.saved.received[id] = r.head.id;
      known.add(r.head.id);
    }
  }

  /** Writes each inbox task once, and its run whenever it changed. */
  private async send(sync: DriveSync): Promise<void> {
    const now = this.now();
    for (const t of await this.d.inbox.list()) {
      if (t.endedAt && now - t.endedAt > KEEP_FINISHED_MS) continue;
      const fromDrive = this.saved.received[t.id];
      const id = fromDrive ?? syncIdFor(t.id);
      if (!fromDrive && !sync.records().some((r) => r.head.kind === "task" && r.head.id === id)) {
        const task: SyncTaskBody = {
          type: "task",
          title: scrubText(t.title, this.d.home).slice(0, 200),
          spec: scrubText(t.goal, this.d.home).slice(0, 8000),
          origin: ORIGIN[t.from],
          executor: t.runBy,
          target: this.saved.writer,
          createdAt: iso(t.startedAt) ?? new Date(now).toISOString(),
          risk: t.risk,
        };
        await sync.write("task", id, task);
        this.wrote = true;
      }
      const run: SyncRunBody = {
        type: "run",
        state: runState(t),
        ...(t.note ? { status: scrubText(t.note, this.d.home).slice(0, 200) } : {}),
        ...(t.summary ? { result: scrubText(t.summary, this.d.home).slice(0, 4000) } : {}),
        ...(t.branch ? { branch: t.branch } : {}),
        ...(t.modelUsed ? { model: t.modelUsed.slice(0, 80) } : {}),
        ...(iso(t.startedAt) ? { startedAt: iso(t.startedAt) } : {}),
        ...(iso(t.endedAt) ? { endedAt: iso(t.endedAt) } : {}),
      };
      const fp = hash(run);
      if (this.saved.sent[t.id] === fp) continue;
      try {
        await sync.write("run", id, run);
        this.wrote = true;
      } catch (e) {
        // Another device already owns this run (or the task was deleted): note it once, do not retry every sync.
        this.d.log?.(`Tasks sync: a run was not written (${errorText(e).slice(0, 80)}).`);
      }
      this.saved.sent[t.id] = fp;
    }
  }

  /** Writes the snapshots that are due (see {@link TasksSync.observeAgent}); an ended run is then forgotten. */
  private async sendAgents(sync: DriveSync): Promise<void> {
    const now = this.now();
    for (const [runId, a] of this.agents) {
      const going = AGENT_GOING.has(a.snap.state);
      const body = agentBody(a.snap, a.summary, this.d.home);
      const fp = hash(body);
      const due = fp !== a.sentFp && (!going || a.sentAt === undefined || now - a.sentAt >= SYNC_LIMITS.agentWriteEveryMs);
      if (due) {
        try {
          await sync.write("agent", agentSyncId(runId), { ...body, updatedAt: new Date(now).toISOString() });
          this.wrote = true;
        } catch (e) {
          this.d.log?.(`Tasks sync: an agent snapshot was not written (${errorText(e).slice(0, 80)}).`);
        }
        a.sentAt = now;
        a.sentFp = fp;
      }
      if (!going) this.agents.delete(runId);
    }
  }
}

/**
 * The record id of an agent run's snapshot: `a-` and a hash of its run id (stable, so each run is one facet whose
 * newest revision is the one kept).
 *
 * @param runId - The run id (agent-activity.ts).
 */
export function agentSyncId(runId: string): string {
  return `a-${createHash("sha256").update(runId).digest("hex").slice(0, 20)}`;
}

/**
 * An agent run as a snapshot body: who, what, which model, how far, and a short result. Titles and results are
 * scrubbed of the home folder; nothing of the prompt, files or output is in it.
 *
 * @param s - The run.
 * @param summary - Its result line, if any.
 * @param home - The home folder to scrub.
 */
export function agentBody(s: RunSnapshot, summary: string | undefined, home = homedir()): SyncAgentBody {
  const result = summary ?? s.failReason ?? (s.branch ? `Branch ${s.branch}` : undefined);
  return {
    type: "agent",
    title: scrubText(s.title, home).slice(0, 200),
    source: s.source,
    state: s.state,
    ...(s.model ? { model: s.model.slice(0, 80) } : {}),
    ...(s.step ? { steps: s.step } : {}),
    ...(iso(s.startedAt) ? { startedAt: iso(s.startedAt) } : {}),
    ...(iso(s.endedAt) ? { endedAt: iso(s.endedAt) } : {}),
    ...(result ? { summary: scrubText(result, home).slice(0, SYNC_LIMITS.summaryChars) } : {}),
  };
}
