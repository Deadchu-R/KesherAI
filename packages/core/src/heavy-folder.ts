import { copyFile, lstat, mkdir, readdir, readlink, rename, rm, stat, symlink, utimes } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * A folder for heavy things (Roee, 2026-11-17: the Windows drive filled up with engines; "from now on heavy things are
 * kept there"). The big folders of KesherAI's data folder (engines, the self-work worker's data, Unreal builds,
 * outputs) move to another drive and a link (a junction on Windows, no admin needed) takes their place, so every path
 * already written (Python environments, configs) keeps working and whatever is added later lands on the new drive.
 *
 * Two steps, so nothing in use is pulled away: the files are copied while KesherAI works, then at the next start, before
 * any engine runs, what changed meanwhile is copied again, the old folder is put aside, the link is made, and only then
 * the old folder is removed. If the link cannot be made, the old folder is put back.
 */

/** The folders of the data folder that can be heavy. */
export const HEAVY_FOLDERS = ["engines", "worker", "unreal", "outputs"] as const;
/** One of the heavy folders. */
export type HeavyName = (typeof HEAVY_FOLDERS)[number];

/** A folder waiting for the next start to finish moving. */
export interface HeavyPending {
  name: HeavyName;
  to: string;
}

/** Where a copy stands. */
export interface HeavyCopy {
  running: boolean;
  files: number;
  done: number;
  bytes: number;
  bytesDone: number;
  error?: string;
  /** Copied, waiting for a restart to finish. */
  ready: HeavyName[];
}

/** Every file under a folder, with size and time; a link inside is listed as a link (not followed). */
async function filesUnder(root: string): Promise<Array<{ path: string; size: number; mtime: number; link?: string }>> {
  const out: Array<{ path: string; size: number; mtime: number; link?: string }> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        const link = await readlink(p).catch(() => undefined);
        if (link) out.push({ path: p, size: 0, mtime: 0, link });
      } else if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const st = await stat(p).catch(() => undefined);
        if (st) out.push({ path: p, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  await walk(root);
  return out;
}

/**
 * Copies `from` into `to`, skipping files already there with the same size and time.
 *
 * @returns The number of files copied.
 */
export async function syncFolder(from: string, to: string, onFile?: (size: number) => void, signal?: AbortSignal): Promise<number> {
  let copied = 0;
  for (const f of await filesUnder(from)) {
    if (signal?.aborted) throw new Error("Stopped.");
    const target = join(to, relative(from, f.path));
    if (f.link) {
      // A link inside (Python's bin/python on Linux and macOS): made again as the same link.
      if (!(await isLink(target))) {
        await mkdir(dirname(target), { recursive: true });
        await rm(target, { recursive: true, force: true });
        await symlink(f.link, target);
        copied++;
      }
      onFile?.(0);
      continue;
    }
    const there = await stat(target).catch(() => undefined);
    if (!there || there.size !== f.size || Math.abs(there.mtimeMs - f.mtime) > 2000) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(f.path, target);
      if ((await stat(target)).size !== f.size) throw new Error(`The copy of ${relative(from, f.path)} is not the same size.`);
      await utimes(target, new Date(), new Date(f.mtime)).catch(() => undefined);
      copied++;
    }
    onFile?.(f.size);
  }
  return copied;
}

/** @returns Whether `p` is a link (a junction on Windows) and not a real folder. */
export async function isLink(p: string): Promise<boolean> {
  return (await lstat(p).catch(() => undefined))?.isSymbolicLink() ?? false;
}

/**
 * At start-up, before any engine runs: finishes the folders that were copied (copies what changed since, puts the old
 * folder aside, makes the link, removes the old folder). A folder that cannot be finished (in use) stays pending.
 *
 * @param root - KesherAI's data folder.
 * @param pending - The folders waiting.
 * @param log - Where to say what happened.
 * @returns The folders still pending.
 */
export async function finishPending(root: string, pending: HeavyPending[], log: (line: string) => void = () => undefined): Promise<HeavyPending[]> {
  const left: HeavyPending[] = [];
  for (const p of pending) {
    if (!(HEAVY_FOLDERS as readonly string[]).includes(p.name)) continue;
    const src = join(root, p.name);
    const to = resolve(p.to);
    try {
      if (await isLink(src)) continue;
      const here = await stat(src).catch(() => undefined);
      await mkdir(to, { recursive: true });
      if (here?.isDirectory()) await syncFolder(src, to);
      const aside = `${src}.moved-${Date.now()}`;
      if (here) await rename(src, aside);
      try {
        await symlink(to, src, process.platform === "win32" ? "junction" : "dir");
      } catch (e) {
        if (here) await rename(aside, src);
        throw e;
      }
      if (here) void rm(aside, { recursive: true, force: true }).then(() => log(`Heavy folder: ${p.name} now lives in ${to}.`), (e: Error) => log(`Heavy folder: the old ${p.name} could not be removed (${e.message}).`));
      else log(`Heavy folder: ${p.name} now lives in ${to}.`);
    } catch (e) {
      log(`Heavy folder: ${p.name} stays for now (${(e as Error).message}).`);
      left.push(p);
    }
  }
  return left;
}

/** Moves heavy folders to another drive: copies now, finishes at the next start. */
export class HeavyFolder {
  private st: HeavyCopy = { running: false, files: 0, done: 0, bytes: 0, bytesDone: 0, ready: [] };
  private stop?: AbortController;

  /**
   * @param root - KesherAI's data folder.
   * @param savePending - Keeps the list of folders to finish at the next start (in the config).
   */
  constructor(
    private readonly root: string,
    private readonly savePending: (p: HeavyPending[]) => Promise<void>,
  ) {}

  /** @returns Each heavy folder: its size and whether it already lives elsewhere. */
  async folders(): Promise<Array<{ name: HeavyName; bytes: number; linked: boolean; to?: string }>> {
    const out: Array<{ name: HeavyName; bytes: number; linked: boolean; to?: string }> = [];
    for (const name of HEAVY_FOLDERS) {
      const p = join(this.root, name);
      const linked = await isLink(p);
      const bytes = (await filesUnder(p)).reduce((n, f) => n + f.size, 0);
      out.push({ name, bytes, linked });
    }
    return out;
  }

  /** Where the copy stands. */
  status(): HeavyCopy {
    return { ...this.st, ready: [...this.st.ready] };
  }

  /** Stops the copy after the current file. */
  cancel(): void {
    this.stop?.abort();
  }

  /**
   * Starts copying the folders into `dir` (returns at once).
   *
   * @param dir - The folder for heavy things, e.g. E:\KesherAI (each folder goes into it by name).
   * @param names - Which folders.
   */
  start(dir: string, names: HeavyName[]): HeavyCopy {
    if (this.st.running) throw Object.assign(new Error("A move is already running."), { statusCode: 409 });
    const to = resolve(dir);
    const root = resolve(this.root);
    if ((to + sep).startsWith(root + sep) || (root + sep).startsWith(to + sep)) throw Object.assign(new Error("Pick a folder outside KesherAI's data folder (another drive)."), { statusCode: 400 });
    const list = names.filter((n) => (HEAVY_FOLDERS as readonly string[]).includes(n));
    if (!list.length) throw Object.assign(new Error("Which folders?"), { statusCode: 400 });
    this.stop = new AbortController();
    this.st = { running: true, files: 0, done: 0, bytes: 0, bytesDone: 0, ready: [] };
    void this.run(to, list, this.stop.signal);
    return this.status();
  }

  /** Waits for the copy to end (tests). */
  async idle(): Promise<void> {
    while (this.st.running) await new Promise((r) => setTimeout(r, 20));
  }

  private async run(to: string, names: HeavyName[], signal: AbortSignal): Promise<void> {
    try {
      const todo: HeavyName[] = [];
      for (const n of names) {
        if (await isLink(join(this.root, n)) || !(await stat(join(this.root, n)).catch(() => undefined))?.isDirectory()) continue;
        const files = await filesUnder(join(this.root, n));
        this.st.files += files.length;
        this.st.bytes += files.reduce((s, f) => s + f.size, 0);
        todo.push(n);
      }
      for (const n of todo) {
        await syncFolder(join(this.root, n), join(to, n), (size) => { this.st.done++; this.st.bytesDone += size; }, signal);
        this.st.ready.push(n);
      }
      await this.savePending(this.st.ready.map((name) => ({ name, to: join(to, name) })));
    } catch (e) {
      this.st.error = (e as Error).message;
      if (this.st.ready.length) await this.savePending(this.st.ready.map((name) => ({ name, to: join(to, name) }))).catch(() => undefined);
    } finally {
      this.st.running = false;
    }
  }
}

/**
 * Where heavy things go when the user has not chosen: next to the models when they live outside the data folder (E:\KesherAI
 * for E:\KesherAI\models), else nothing (the data folder stays).
 *
 * @param modelsDir - The models download folder.
 * @param root - KesherAI's data folder.
 */
export function suggestHeavyDir(modelsDir: string, root: string): string | undefined {
  const m = resolve(modelsDir);
  const r = resolve(root);
  if ((m + sep).startsWith(r + sep)) return undefined;
  return dirname(m);
}
