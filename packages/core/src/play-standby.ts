import type { StandbyStatus } from "./gpu-guard.js";

/**
 * Free the graphics card while the game plays (research c-20261121-38, Part D idea 14).
 *
 * When Unity or Unreal goes into Play, the local models (the chat model, the idle image engine…) unload so the game
 * gets the whole card, and they load again when Play ends. The rules:
 * - Only when the setting is on (Settings → Computer and graphics card; on unless the user turned it off).
 * - Never in the middle of an answer: while a local request runs the models stay, new local work already waits, and
 *   they unload right after the request ends (the guard calls {@link PlayStandby.poke} then).
 * - A turn sent while the models are away waits (the chat says "Loading the model back…") instead of failing, and
 *   runs once they are back.
 * - Several editors count together: the card comes back when the last one leaves Play.
 */

/** The part of the guard this needs (GpuGuard implements it; tests pass a fake). */
export interface StandbyTarget {
  /** How many local requests run right now. */
  runningCount(): number;
  /** Holds or releases new local work for the game. */
  holdForPlay(on: boolean): void;
  /** Unloads every loaded engine that is not busy; returns their names. */
  unloadLoaded(): Promise<string[]>;
  /** Loads the named engines again. */
  reloadNamed(names: string[]): Promise<void>;
}

/** An editor that can report Play. */
export type PlayEditor = "unreal" | "unity";

/** The state machine behind "free the graphics card while the game plays". One per server. */
export class PlayStandby {
  private readonly playing = new Set<PlayEditor>();
  /** Models are unloaded for Play. */
  private away = false;
  /** New local work is held for Play (set before the models unload, cleared after they are back). */
  private held = false;
  /** What was unloaded, to load again. */
  private freed: string[] = [];
  /** The step in progress, so two pokes never unload or reload at the same time. */
  private working: Promise<void> | undefined;

  /**
   * @param target - The guard.
   * @param enabled - Whether the setting is on (read at every step, so a change applies at once).
   * @param notify - Tells the user something happened; optional.
   */
  constructor(
    private readonly target: StandbyTarget,
    private readonly enabled: () => boolean,
    private readonly notify: (text: string) => void = () => undefined,
  ) {}

  /**
   * An editor entered or left Play.
   *
   * @param editor - Which one.
   * @param on - True when Play started.
   * @returns Resolves when this change has been applied (models unloaded or loaded again).
   */
  setPlay(editor: PlayEditor, on: boolean): Promise<void> {
    if (on) this.playing.add(editor);
    else this.playing.delete(editor);
    return this.poke();
  }

  /** @returns Whether the given editor is in Play now. */
  isPlaying(editor: PlayEditor): boolean {
    return this.playing.has(editor);
  }

  /**
   * Looks at the state again and does what is due: unload when Play started and nothing is mid-answer, load again
   * when Play ended or the setting was turned off. Called after every change, when the guard goes idle, and by the
   * setting's route.
   *
   * @returns Resolves when nothing more is due right now.
   */
  async poke(): Promise<void> {
    // One step at a time; whatever changed meanwhile is looked at again after it.
    while (this.working) await this.working;
    this.working = this.step().finally(() => (this.working = undefined));
    await this.working;
  }

  private async step(): Promise<void> {
    const want = this.enabled() && this.playing.size > 0;
    if (want && !this.away) {
      // New local work waits from now on; what already runs finishes first (never cut a running turn).
      this.held = true;
      this.target.holdForPlay(true);
      if (this.target.runningCount() > 0) return;
      this.away = true;
      this.freed = await this.target.unloadLoaded();
      if (this.freed.length) this.notify("Free the graphics card: the models are unloaded while the game plays.");
      return;
    }
    if (!want && this.held) {
      // Loaded again first, then the waiting turns go on (so they do not start a second load).
      await this.target.reloadNamed(this.freed).catch(() => undefined);
      this.away = false;
      this.freed = [];
      this.held = false;
      this.target.holdForPlay(false);
    }
  }

  /** @returns Where it stands, for the status shown in Models, the model chip and the chat; undefined when idle. */
  status(): StandbyStatus | undefined {
    if (!this.held) return undefined;
    return { state: this.away ? "paused" : "waiting", editors: [...this.playing], freed: this.freed };
  }
}
