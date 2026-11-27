/**
 * Which games run right now, for anything that should step aside while the user plays (Roee, 27.11: after a restart
 * the 27B chat model loaded itself onto the card as Slay the Spire 2 started). The same matching as the task inbox's
 * busy check (inbox-busy.ts): installed games' folders (pc-games.ts, read every 10 minutes) against the running
 * programs (every 30 seconds).
 */
import { busyPrograms, gameFoldersForBusy, runningPrograms } from "./inbox-busy.js";
import { findGamesAndStoreApps } from "./pc-games.js";

/** What the watch needs (tests pass fakes). */
export interface GameWatchDeps {
  games?: () => Promise<Array<{ name: string; folder: string }>>;
  programs?: () => ReturnType<typeof runningPrograms>;
  now?: () => number;
}

/** Answers "is a game running", cached so callers can ask often. */
export class GameWatch {
  private games = { at: 0, list: [] as Array<{ name: string; folder: string }> };
  private programs = { at: 0, list: [] as Awaited<ReturnType<typeof runningPrograms>> };

  /**
   * @param d - In tests: fakes for the installed games, the running programs and the clock.
   */
  constructor(private readonly d: GameWatchDeps = {}) {}

  /** The look in progress: callers that ask at the same moment share it (one folder scan, one process list). */
  private looking?: Promise<string[]>;

  /** The names of the games running now (empty when none, or when they could not be read). */
  running(): Promise<string[]> {
    this.looking ??= this.look().finally(() => (this.looking = undefined));
    return this.looking;
  }

  /** The names of the programs in the last look (no new scan; for the light profile's per-program list). */
  programNames(): string[] {
    return this.programs.list.map((p) => p.name);
  }

  /** One look, with the caches. */
  private async look(): Promise<string[]> {
    const now = (this.d.now ?? Date.now)();
    if (now - this.games.at > 10 * 60_000) this.games = { at: now, list: await (this.d.games ?? (async () => gameFoldersForBusy(await findGamesAndStoreApps())))().catch(() => []) };
    if (now - this.programs.at > 30_000) this.programs = { at: now, list: await (this.d.programs ?? runningPrograms)().catch(() => []) };
    return busyPrograms(this.programs.list, this.games.list).games;
  }
}
