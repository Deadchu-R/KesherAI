import { copyFile, mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Where a move of the models folder stands. */
export interface MoveStatus {
  running: boolean;
  from?: string;
  to?: string;
  files: number;
  done: number;
  bytes: number;
  bytesDone: number;
  /** Files left where they were (in use by a loaded model, or they could not be copied). */
  kept: string[];
  error?: string;
  finishedAt?: number;
}

/** Every file under a folder (no links followed), with its size. */
async function filesUnder(root: string): Promise<Array<{ path: string; size: number }>> {
  const out: Array<{ path: string; size: number }> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push({ path: p, size: (await stat(p)).size });
    }
  };
  await walk(root);
  return out;
}

/**
 * Moves the models from an old folder into the new download folder (another drive too), file by file: a rename on the
 * same drive, else a copy that is checked (same size) before the old file is removed. A file already there with the
 * same size is not copied again. A file in use (a model loaded right now, locked on Windows) stays and is listed.
 */
export class ModelsMove {
  private st: MoveStatus = { running: false, files: 0, done: 0, bytes: 0, bytesDone: 0, kept: [] };
  private stop?: AbortController;

  /** Where the move stands now (a copy). */
  status(): MoveStatus {
    return { ...this.st, kept: [...this.st.kept] };
  }

  /** Stops after the file being moved now. */
  cancel(): void {
    this.stop?.abort();
  }

  /** Starts moving `from` into `to` (not inside each other); returns at once, progress in status(). */
  start(from: string, to: string): MoveStatus {
    if (this.st.running) throw Object.assign(new Error("A move is already running."), { statusCode: 409 });
    const a = resolve(from);
    const b = resolve(to);
    if (a === b || (b + sep).startsWith(a + sep) || (a + sep).startsWith(b + sep)) throw Object.assign(new Error("The two folders must not be inside each other."), { statusCode: 400 });
    this.stop = new AbortController();
    this.st = { running: true, from: a, to: b, files: 0, done: 0, bytes: 0, bytesDone: 0, kept: [] };
    void this.run(a, b, this.stop.signal);
    return this.status();
  }

  /** Waits for the move to end (tests). */
  async idle(): Promise<void> {
    while (this.st.running) await new Promise((r) => setTimeout(r, 20));
  }

  private async run(from: string, to: string, signal: AbortSignal): Promise<void> {
    try {
      const list = await filesUnder(from);
      this.st.files = list.length;
      this.st.bytes = list.reduce((n, f) => n + f.size, 0);
      for (const f of list) {
        if (signal.aborted) break;
        const target = join(to, relative(from, f.path));
        await mkdir(dirname(target), { recursive: true });
        try {
          const there = await stat(target).catch(() => undefined);
          if (there?.size === f.size) await unlink(f.path);
          else {
            try {
              await rename(f.path, target);
            } catch (e) {
              // Another drive (EXDEV), or in use: copy, check, then remove the old one.
              if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
              await copyFile(f.path, target);
              if ((await stat(target)).size !== f.size) {
                await rm(target, { force: true });
                throw new Error("The copy is not the same size.");
              }
              await unlink(f.path);
            }
          }
        } catch {
          this.st.kept.push(relative(from, f.path));
        }
        this.st.done++;
        this.st.bytesDone += f.size;
      }
    } catch (e) {
      this.st.error = (e as Error).message;
    } finally {
      this.st.running = false;
      this.st.finishedAt = Date.now();
    }
  }
}
