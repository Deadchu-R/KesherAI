import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";

/** How long an Open mind recording stays on this computer for "Transcribe again". */
export interface AudioPolicy {
  /** `days`: for `days` days; `forever`: until she deletes it; `off`: not kept at all. */
  mode: "days" | "forever" | "off";
  days: number;
  /** All kept recordings together: above it the oldest go first. */
  capBytes: number;
}

/** What is kept for one session. */
export interface KeptAudio {
  path: string;
  bytes: number;
  /** When it was kept (ms). */
  t: number;
}

const SID = /^[\w-]{1,64}$/;
const EXT = /^\.(m4a|webm|ogg|wav)$/;
const DAY = 86_400_000;

/**
 * Open mind recordings kept for "Transcribe again as …": one file per session, `<session id>.<type>`, in a folder of
 * KesherAI's data on this computer only (never synced to the hub or a cloud, never sent to a phone). Cleanup follows
 * the policy: nothing when `off`, older than `days` when `days`, and the oldest first above the size cap.
 */
export class IdeaAudio {
  /**
   * @param dir - The folder of kept recordings.
   * @param now - The clock (tests set it).
   */
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Moves a recording into the store (a copy when the move crosses disks), under the session's id.
   *
   * @param id - The session.
   * @param file - The recording's path; it is gone from there afterwards.
   * @returns Where it is now.
   */
  async adopt(id: string, file: string): Promise<string> {
    if (!SID.test(id)) throw new Error("Bad session id.");
    const ext = extname(file).toLowerCase();
    await mkdir(this.dir, { recursive: true });
    await this.remove(id);
    const to = join(this.dir, `${id}${EXT.test(ext) ? ext : ".m4a"}`);
    try {
      await rename(file, to);
    } catch {
      await copyFile(file, to);
      await rm(file, { force: true });
    }
    return to;
  }

  /** The kept recording of a session, when there is one. */
  async find(id: string): Promise<KeptAudio | undefined> {
    if (!SID.test(id)) return undefined;
    for (const e of await this.entries()) if (e.id === id) return { path: e.path, bytes: e.bytes, t: e.t };
    return undefined;
  }

  /** Deletes a session's recording (nothing happens when there is none). */
  async remove(id: string): Promise<void> {
    if (!SID.test(id)) return;
    for (const e of await this.entries()) if (e.id === id) await rm(e.path, { force: true });
  }

  /**
   * Deletes what the policy no longer allows: everything when `off`; recordings of sessions that no longer exist;
   * those older than the days; then the oldest until the total fits the cap.
   *
   * @param policy - The settings.
   * @param sessions - The ids of the sessions that exist.
   * @returns The ids whose recording was deleted.
   */
  async cleanup(policy: AudioPolicy, sessions: ReadonlySet<string>): Promise<string[]> {
    const gone: string[] = [];
    const drop = async (e: { id: string; path: string }) => {
      await rm(e.path, { force: true });
      gone.push(e.id);
    };
    const left = [];
    for (const e of await this.entries()) {
      const old = policy.mode === "days" && this.now() - e.t > policy.days * DAY;
      if (policy.mode === "off" || !sessions.has(e.id) || old) await drop(e);
      else left.push(e);
    }
    let total = left.reduce((n, e) => n + e.bytes, 0);
    for (const e of left.sort((a, b) => a.t - b.t)) {
      if (total <= policy.capBytes) break;
      total -= e.bytes;
      await drop(e);
    }
    return gone;
  }

  private async entries(): Promise<Array<KeptAudio & { id: string }>> {
    const out = [];
    for (const n of await readdir(this.dir).catch(() => [] as string[])) {
      const ext = extname(n);
      const id = n.slice(0, n.length - ext.length);
      if (!EXT.test(ext) || !SID.test(id)) continue;
      const st = await stat(join(this.dir, n)).catch(() => undefined);
      if (st?.isFile()) out.push({ id, path: join(this.dir, n), bytes: st.size, t: st.mtimeMs });
    }
    return out;
  }
}

/**
 * When a kept recording will be deleted by the days rule.
 *
 * @param policy - The settings.
 * @param t - When it was kept (ms).
 * @returns The time (ms), or undefined when it stays until she deletes it.
 */
export function audioUntil(policy: AudioPolicy, t: number): number | undefined {
  return policy.mode === "days" ? t + policy.days * DAY : undefined;
}
