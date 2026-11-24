/**
 * "Install when the computer is free": the update waits until nothing would be
 * cut off by the restart (no chat working, self-work not running, no download),
 * then installs by itself. Like an OS's "update outside active hours", but the
 * signal is KesherAI's own work instead of a clock. On by default; the choice is
 * kept in config (taskInbox.installWhenFree), so it is on again after the restart.
 */

import type { UpdateDrain } from "./update-drain.js";

/** A chat that only waits for the user (a question, an approval) this long no longer holds the install back. */
export const WAITING_GRACE_MS = 6 * 3_600_000;

/** One chat's activity: what it does, and since when. */
export interface ChatActivity {
  status: "running" | "waiting";
  /** When it got this status (ms since 1970). */
  since: number;
}

/**
 * The chats that hold the install back: every working chat, and a chat waiting for the user for less than
 * {@link WAITING_GRACE_MS} (a longer one is resumed after the restart anyway, so it must not block forever).
 * @param chats - Chat id to its activity.
 * @param now - The time now (ms).
 * @returns The ids of the chats that block.
 */
export function blockingChats(chats: Record<string, ChatActivity>, now: number): string[] {
  return Object.entries(chats)
    .filter(([, a]) => a.status === "running" || now - a.since < WAITING_GRACE_MS)
    .map(([id]) => id);
}

/** What is busy now; any of these holds the install back. */
export interface FreeState {
  /** Chats answering right now. */
  chats: number;
  /** Self-work is running a task. */
  selfWork: boolean;
  /** Downloads that are moving (downloading or queued). */
  downloads: number;
  /** An update is already being installed. */
  updating: boolean;
  /** Study model calls running (a summary, a quiz being written or graded). */
  study?: number;
  /** An inbox agent task (Antigravity / local) is running. */
  agentTask?: string;
}

/** The longest one look may wait on a check; a hung check must never stop every later look. */
const LOOK_MS = 60_000;

/**
 * Settles with `work`, or rejects after `ms`.
 * @param work - The call.
 * @param ms - The longest wait.
 * @returns What `work` returned.
 */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
    timer.unref?.();
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Whether the computer is free for a restart.
 * @param s - What is busy now.
 */
export function isFree(s: FreeState): boolean {
  return s.chats === 0 && !s.selfWork && s.downloads === 0 && !s.updating && !s.study && !s.agentTask;
}

/** What the waiter needs from KesherAI. */
export interface InstallWhenFreeDeps {
  /** Reads what is busy now. */
  state: () => Promise<FreeState>;
  /** The longest one look waits on `state` or `available` (default 60 s). */
  lookMs?: number;
  /** Whether a newer version is ready to install. */
  available: () => Promise<boolean>;
  /** Installs it (restarts KesherAI). */
  apply: () => Promise<unknown>;
  /**
   * Called just before {@link apply}: writes the "Continue what was running" record (resume-board.ts), so work that
   * still runs (a helper, a sync; the free check does not wait for those) shows on the card after the update.
   */
  beforeApply?: () => Promise<unknown>;
  /** How often to look, in ms (default 30 s). */
  everyMs?: number;
  /** How often to ask whether a version is ready, in ms (default 5 min). */
  checkEveryMs?: number;
  /**
   * The shared drain flag: set while a version is ready and waits for a free moment, so no new agent run starts
   * (update-drain.ts). Absent: the old behaviour (only wait).
   */
  drain?: UpdateDrain;
  /** Called once when the drain lasted long (the phone gets "Update waiting for ..." with an "Install now" button). */
  onLongDrain?: () => Promise<unknown> | unknown;
}

/** Waits for a free moment and installs the ready update then. */
export class InstallWhenFree {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastCheck = 0;
  private ready = false;
  private busy = false;
  /**
   * @param deps - Reads what is busy, whether a version is ready, and installs it.
   */
  constructor(private readonly deps: InstallWhenFreeDeps) {}

  /** Whether it is waiting now. */
  get on(): boolean {
    return !!this.timer;
  }

  /**
   * Turns waiting on or off. Turning it on looks once right away.
   * @param on - True to wait for a free moment and install.
   */
  set(on: boolean): void {
    if (!on) return this.stop();
    if (this.timer) return;
    this.lastCheck = 0;
    this.ready = false;
    this.timer = setInterval(() => void this.tick(), this.deps.everyMs ?? 30_000);
    this.timer.unref?.();
    void this.tick();
  }

  /** Stops waiting (and lets new runs start again). */
  stop(): void {
    this.halt();
    this.deps.drain?.end();
  }

  private halt(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One look: installs if a version is ready and the computer is free.
   * @returns True when it started the install.
   */
  async tick(): Promise<boolean> {
    if (this.busy || !this.timer) return false;
    this.busy = true;
    try {
      if (!this.ready || Date.now() - this.lastCheck > (this.deps.checkEveryMs ?? 300_000)) {
        this.lastCheck = Date.now();
        this.ready = await within(this.deps.available(), this.deps.lookMs ?? LOOK_MS).catch(() => false);
      }
      const drain = this.deps.drain;
      // A ready version drains: running work finishes, nothing new starts (so a free moment comes).
      if (this.ready) drain?.begin();
      else drain?.end();
      if (!this.ready) return false;
      if (!isFree(await within(this.deps.state(), this.deps.lookMs ?? LOOK_MS))) {
        if (drain?.takeLongNotice()) await Promise.resolve(this.deps.onLongDrain?.()).catch(() => undefined);
        return false;
      }
      // The drain stays on until the restart: no run may slip in between this look and the install.
      this.halt();
      await this.deps.beforeApply?.().catch(() => undefined);
      await this.deps.apply();
      return true;
    } catch {
      if (!this.timer) this.deps.drain?.end();
      return false;
    } finally {
      this.busy = false;
    }
  }
}
