import { basename } from "node:path";

/** What the study page shows while a course waits for its own model. */
export interface StudyModelWait {
  /** The model the course waits for (its file name). */
  want: string;
  /** The model loaded now (its file name). */
  now?: string;
  /** Why it waits: a chat or self-work is using the loaded model. */
  why: "chat" | "self-work";
  since: number;
}

/**
 * Loads a course's own model (a Hebrew one) in the engine for study work, and puts the earlier model back after.
 *
 * Roee's choice (2026-11-16): switch by itself once nothing else uses the model (no chat answering, no self-work),
 * then switch back; "Switch now" on the page does it at once. One engine holds one model, so the loads are in turn.
 */
export class StudyModelSwitch {
  private waiting?: StudyModelWait;
  private forced = false;
  private back?: string;
  private active = 0;
  private timer?: NodeJS.Timeout;
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param deps.loaded - The GGUF the engine has loaded now.
   * @param deps.load - Loads a GGUF in the engine (the user's chat model setting stays as it is).
   * @param deps.busy - What uses the loaded model now, if anything.
   * @param deps.backAfterMs - How long study work may be idle before the earlier model comes back.
   */
  constructor(
    private readonly deps: {
      loaded: () => string | undefined;
      load: (path: string) => Promise<void>;
      busy: () => "chat" | "self-work" | undefined | Promise<"chat" | "self-work" | undefined>;
      backAfterMs?: number;
      wait?: (ms: number) => Promise<void>;
    },
  ) {}

  /** @returns What a course waits for, if one does. */
  status(): { waiting?: StudyModelWait; switched: boolean } {
    return { ...(this.waiting ? { waiting: this.waiting } : {}), switched: !!this.back };
  }

  /** "Switch now": stop waiting for the chat or self-work to finish. */
  now(): void {
    this.forced = true;
  }

  /**
   * Runs study work on a model file, loading it first when another is loaded.
   *
   * @param path - The course's GGUF.
   * @param run - The work.
   * @param signal - Stops the waiting.
   */
  async use<T>(path: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    clearTimeout(this.timer);
    if (this.deps.loaded() !== path) {
      // One switch at a time: a second course call waits for the first load, then finds its model loaded.
      const load = this.chain.then(() => this.switchTo(path, signal));
      this.chain = load.catch(() => undefined);
      await load;
    }
    this.active++;
    try {
      return await run();
    } finally {
      this.active--;
      if (!this.active && this.back) this.laterBack();
    }
  }

  private async switchTo(path: string, signal?: AbortSignal): Promise<void> {
    if (this.deps.loaded() === path) return;
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let why = await this.deps.busy();
    while (why && !this.forced) {
      this.waiting = { want: basename(path), ...(this.deps.loaded() ? { now: basename(this.deps.loaded()!) } : {}), why, since: this.waiting?.since ?? Date.now() };
      if (signal?.aborted) {
        this.waiting = undefined;
        throw Object.assign(new Error("Stopped while waiting for the course's model."), { statusCode: 499 });
      }
      await wait(3000);
      why = await this.deps.busy();
    }
    this.waiting = undefined;
    this.forced = false;
    this.back ??= this.deps.loaded();
    await this.deps.load(path);
  }

  /** Puts the earlier model back once study work has been idle for a while. */
  private laterBack(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const back = this.back;
      if (this.active || !back) return;
      this.back = undefined;
      this.chain = this.chain.then(() => (this.deps.loaded() === back ? undefined : this.deps.load(back))).catch(() => undefined);
    }, this.deps.backAfterMs ?? 180_000);
    this.timer.unref?.();
  }
}
