/**
 * "Install when the computer is free": the update waits until nothing would be
 * cut off by the restart (no chat working, self-work not running, no download),
 * then installs by itself. Like an OS's "update outside active hours", but the
 * signal is KesherAI's own work instead of a clock. Kept in memory only: a
 * restart (the install itself) turns it off.
 */

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
}

/**
 * Whether the computer is free for a restart.
 * @param s - What is busy now.
 */
export function isFree(s: FreeState): boolean {
  return s.chats === 0 && !s.selfWork && s.downloads === 0 && !s.updating;
}

/** What the waiter needs from KesherAI. */
export interface InstallWhenFreeDeps {
  /** Reads what is busy now. */
  state: () => Promise<FreeState>;
  /** Whether a newer version is ready to install. */
  available: () => Promise<boolean>;
  /** Installs it (restarts KesherAI). */
  apply: () => Promise<unknown>;
  /** How often to look, in ms (default 30 s). */
  everyMs?: number;
  /** How often to ask whether a version is ready, in ms (default 5 min). */
  checkEveryMs?: number;
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

  /** Stops waiting. */
  stop(): void {
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
        this.ready = await this.deps.available().catch(() => false);
      }
      if (!this.ready || !isFree(await this.deps.state())) return false;
      this.stop();
      await this.deps.apply();
      return true;
    } catch {
      return false;
    } finally {
      this.busy = false;
    }
  }
}
