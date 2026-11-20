import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

/**
 * Checkpoints around engine writes (RESEARCH_LOG "Gap list: engine work without the engine open", 2026-11-20, step 5).
 *
 * Before KesherAI writes a file of a Unity, Unreal or Godot project (a chat's engine tools, a queued sync batch, a
 * Source view save, a scene stand-in save), the file as it was is copied into one checkpoint: one per chat turn or
 * sync batch, so a whole change rolls back in one tap. Roee's decisions (2026-11-20):
 * - binaries too (.uasset, .umap, .unity, .prefab, ...), but ONLY the files KesherAI touches (never the whole project);
 * - kept on the heavy-data drive (the app's heavy-data/models setting), not on C:;
 * - restore per checkpoint from the Game projects page and from the chat; prune by age and size, with the size shown.
 *
 * Layout of the store folder: `index.json` (the checkpoints, oldest first) and `blobs/ab/<sha256>` (each file's bytes
 * once, shared by every checkpoint that holds the same content). A file that did not exist before the write is kept as
 * an entry without a blob: restoring removes it.
 */

/** The engines a project can belong to. */
export type GameEngine = "unity" | "unreal" | "godot";
/** What took the checkpoint. */
export type CheckpointSource = "chat" | "sync" | "source" | "stand-in" | "restore";

/** One file in a checkpoint, as it was before the write. */
export interface GameCheckpointFile {
  /** Its path inside the project, with "/". */
  rel: string;
  /** Its size then (0 when it did not exist). */
  size: number;
  /** Its content's sha256 (absent: the file did not exist, so restoring removes it). */
  blob?: string;
  /** Too big to keep (over {@link MAX_FILE}): listed, not restorable. */
  skipped?: boolean;
}

/** One checkpoint: the files one chat turn, sync batch or save touched, as they were before. */
export interface GameCheckpoint {
  id: string;
  engine: GameEngine;
  /** The project folder. */
  project: string;
  /** The project's name, for the list. */
  name: string;
  source: CheckpointSource;
  /** What it is before (the chat message, "Sync: 3 changes", "Save Player.cs"). */
  label: string;
  /** Groups the writes of one chat turn or sync batch into this checkpoint. */
  group: string;
  /** The chat it came from, when it came from one. */
  chatId?: string;
  at: string;
  files: GameCheckpointFile[];
}

/** How long and how much the store keeps (Settings on the Game projects page). */
export interface CheckpointLimits {
  /** Checkpoints older than this many days are removed. */
  days: number;
  /** The store's size limit; the oldest checkpoints go first. */
  maxMB: number;
}

/** What is kept when nothing was chosen. */
export const DEFAULT_LIMITS: CheckpointLimits = { days: 30, maxMB: 4096 };
/** A single file bigger than this is listed but not copied (a cooked build or a video, not something an edit touches). */
export const MAX_FILE = 2 * 1024 * 1024 * 1024;
/** Text diffs only for files up to this size. */
const MAX_DIFF = 1024 * 1024;
const MAX_CHECKPOINTS = 2000;

/** What capture needs to know about the write. */
export interface CaptureMeta {
  engine: GameEngine;
  project: string;
  name: string;
  source: CheckpointSource;
  label: string;
  group: string;
  chatId?: string;
}

/**
 * A file's place in its project, checked: inside the folder, no "..", no absolute path.
 *
 * @param project - The project folder.
 * @param file - A full path, or one relative to the project.
 * @returns The full path and the relative one (with "/").
 * @throws When the file is outside the project.
 */
export function insideProject(project: string, file: string): { abs: string; rel: string } {
  const root = resolve(project);
  const abs = resolve(root, file);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("The file is not inside the project.");
  return { abs, rel: rel.split(sep).join("/") };
}

/**
 * Checks that a file inside a project (by {@link insideProject}) is really there: the file itself is not a link, and
 * its nearest folder that exists, with links followed, is still inside the project (security scan 168: a link put in
 * a project after a checkpoint must not make a restore write, or a compare read, outside it).
 *
 * @param project - The project folder.
 * @param abs - The file's full path.
 * @throws When the file is a link or leads outside the project.
 */
export async function realInside(project: string, abs: string): Promise<void> {
  const st = await lstat(abs).catch(() => undefined);
  if (st?.isSymbolicLink()) throw new Error("The file is a link: not used here.");
  let probe = st ? dirname(abs) : abs;
  while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
  const [root, real] = await Promise.all([realpath(project), realpath(probe)]);
  const back = relative(root, real);
  if (back.startsWith("..") || isAbsolute(back)) throw new Error("The file leads outside the project.");
}

/** A blob id as the store writes it (a sha256 in hex); anything else in the index is ignored. */
const BLOB_ID = /^[0-9a-f]{64}$/;

/**
 * Whether bytes look like text (no NUL in the first 8 KB), for the diff.
 *
 * @param data - The file's bytes.
 */
export function looksText(data: Buffer): boolean {
  return !data.subarray(0, 8192).includes(0);
}

/** Saves, lists, restores and prunes the checkpoints of game projects. */
export class GameCheckpoints {
  private lock: Promise<unknown> = Promise.resolve();

  /**
   * @param dir - The store folder (resolved at each call: it follows the heavy-data setting).
   * @param limits - The current limits (resolved at each prune).
   */
  constructor(
    private readonly dir: () => string,
    private readonly limits: () => CheckpointLimits = () => DEFAULT_LIMITS,
  ) {}

  /** Runs one change of the index at a time (a chat and a sync can write together). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<GameCheckpoint[]> {
    try {
      const list = JSON.parse(await readFile(join(this.dir(), "index.json"), "utf8")) as GameCheckpoint[];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  private async write(list: GameCheckpoint[]): Promise<void> {
    await mkdir(this.dir(), { recursive: true });
    const file = join(this.dir(), "index.json");
    // Write then rename, so a crash never leaves half an index.
    await writeFile(`${file}.tmp`, JSON.stringify(list.slice(-MAX_CHECKPOINTS)));
    await rename(`${file}.tmp`, file);
  }

  private blobPath(hash: string): string {
    return join(this.dir(), "blobs", hash.slice(0, 2), hash);
  }

  /** Copies a file into the blobs (hashed while it is copied; stored once per content). */
  private async keep(abs: string): Promise<string> {
    const tmpDir = join(this.dir(), "blobs", "tmp");
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, randomUUID());
    const hash = createHash("sha256");
    const tap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(createReadStream(abs), tap, createWriteStream(tmp));
      const id = hash.digest("hex");
      const dest = this.blobPath(id);
      if (existsSync(dest)) await rm(tmp, { force: true });
      else {
        await mkdir(dirname(dest), { recursive: true });
        await rename(tmp, dest);
      }
      return id;
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Keeps the files as they are now, before a write, in the checkpoint of this group (made on the first write of a
   * chat turn or sync batch). A file already in the checkpoint keeps its first copy (the state before the turn).
   *
   * @param meta - The project, what is writing, and the group.
   * @param files - The files about to be written (full paths or relative to the project); others are ignored.
   * @returns The checkpoint, and whether it was made now.
   */
  capture(meta: CaptureMeta, files: string[]): Promise<{ checkpoint: GameCheckpoint; created: boolean } | undefined> {
    return this.serial(async () => {
      const wanted: Array<{ abs: string; rel: string }> = [];
      for (const f of files) {
        try {
          const p = insideProject(meta.project, f);
          if (!wanted.some((w) => w.rel === p.rel)) wanted.push(p);
        } catch {
          // a file outside the project is not ours to keep
        }
      }
      if (!wanted.length) return undefined;
      const list = await this.read();
      let cp = list.find((c) => c.group === meta.group && resolve(c.project) === resolve(meta.project));
      const created = !cp;
      cp ??= { id: randomUUID(), engine: meta.engine, project: resolve(meta.project), name: meta.name, source: meta.source, label: meta.label.slice(0, 200), group: meta.group, ...(meta.chatId ? { chatId: meta.chatId } : {}), at: new Date().toISOString(), files: [] };
      let added = 0;
      for (const w of wanted) {
        if (cp.files.some((f) => f.rel === w.rel)) continue;
        // A link (or a path through one out of the project) is not ours to copy.
        if (!(await realInside(meta.project, w.abs).then(() => true, () => false))) continue;
        const st = await stat(w.abs).catch(() => undefined);
        if (!st || !st.isFile()) cp.files.push({ rel: w.rel, size: 0 });
        else if (st.size > MAX_FILE) cp.files.push({ rel: w.rel, size: st.size, skipped: true });
        else cp.files.push({ rel: w.rel, size: st.size, blob: await this.keep(w.abs) });
        added++;
      }
      if (created) list.push(cp);
      if (added || created) await this.write(list);
      await this.pruneNow(list).catch(() => undefined);
      return { checkpoint: cp, created };
    });
  }

  /**
   * One checkpoint for one save (a Source view save, a scene stand-in save). Never throws: a checkpoint that fails does
   * not stop the save.
   *
   * @param engine - The project's engine.
   * @param project - The project folder.
   * @param source - What saves.
   * @param label - What is saved ("Save Player.cs").
   * @param files - The files about to be written.
   */
  async beforeSave(engine: GameEngine, project: string, source: CheckpointSource, label: string, files: string[]): Promise<GameCheckpoint | undefined> {
    const name = resolve(project).split(sep).pop() ?? project;
    const got = await this.capture({ engine, project, name, source, label, group: `${source}:${randomUUID()}` }, files).catch(() => undefined);
    return got?.checkpoint;
  }

  /**
   * The checkpoints, newest first.
   *
   * @param project - Only this project's (its folder).
   */
  async list(project?: string): Promise<GameCheckpoint[]> {
    const all = await this.read();
    const want = project ? resolve(project).toLowerCase() : undefined;
    return all.filter((c) => !want || c.project.toLowerCase() === want).reverse();
  }

  /** @returns One checkpoint, by id. */
  async get(id: string): Promise<GameCheckpoint | undefined> {
    return (await this.read()).find((c) => c.id === id);
  }

  /**
   * Puts a checkpoint's files back as they were. The files as they are now are kept first (a "restore" checkpoint), so
   * a restore can itself be undone. Files that did not exist then are removed.
   *
   * @param id - The checkpoint.
   * @returns How many files were put back, and the checkpoint taken just before.
   */
  async restore(id: string): Promise<{ restored: number; skipped: number; before?: GameCheckpoint }> {
    const cp = await this.get(id);
    if (!cp) throw new Error("No such checkpoint.");
    const before = await this.capture({ engine: cp.engine, project: cp.project, name: cp.name, source: "restore", label: `Before restoring: ${cp.label}`.slice(0, 200), group: `restore:${randomUUID()}` }, cp.files.map((f) => f.rel));
    return this.serial(async () => {
      let restored = 0;
      let skipped = 0;
      for (const f of cp.files) {
        const { abs } = insideProject(cp.project, f.rel);
        if (f.skipped || (f.blob && !BLOB_ID.test(f.blob)) || !(await realInside(cp.project, abs).then(() => true, () => false))) {
          skipped++;
          continue;
        }
        if (!f.blob) {
          await rm(abs, { force: true });
          restored++;
          continue;
        }
        const blob = this.blobPath(f.blob);
        if (!existsSync(blob)) {
          skipped++;
          continue;
        }
        await mkdir(dirname(abs), { recursive: true });
        await copyFile(blob, abs);
        restored++;
      }
      return { restored, skipped, ...(before ? { before: before.checkpoint } : {}) };
    });
  }

  /**
   * One file of a checkpoint against the file now: both texts when both are text, else only the sizes.
   *
   * @param id - The checkpoint.
   * @param rel - The file's path in the project.
   */
  async compare(id: string, rel: string): Promise<{ rel: string; binary: boolean; before: string | null; now: string | null; sizeBefore: number; sizeNow: number }> {
    const cp = await this.get(id);
    const f = cp?.files.find((x) => x.rel === rel);
    if (!cp || !f) throw new Error("No such file in this checkpoint.");
    const { abs } = insideProject(cp.project, f.rel);
    await realInside(cp.project, abs);
    if (f.blob && !BLOB_ID.test(f.blob)) throw new Error("No such file in this checkpoint.");
    const nowSt = await stat(abs).catch(() => undefined);
    const sizeNow = nowSt?.isFile() ? nowSt.size : 0;
    const out = { rel: f.rel, sizeBefore: f.size, sizeNow };
    if (f.skipped || f.size > MAX_DIFF || sizeNow > MAX_DIFF) return { ...out, binary: true, before: null, now: null };
    const before = f.blob ? await readFile(this.blobPath(f.blob)).catch(() => undefined) : Buffer.alloc(0);
    const now = nowSt?.isFile() ? await readFile(abs) : Buffer.alloc(0);
    if (!before || !looksText(before) || !looksText(now)) return { ...out, binary: true, before: null, now: null };
    return { ...out, binary: false, before: f.blob ? before.toString("utf8") : null, now: nowSt?.isFile() ? now.toString("utf8") : null };
  }

  /**
   * The store's size (each kept content counted once) and where it is.
   */
  async usage(): Promise<{ dir: string; checkpoints: number; bytes: number }> {
    const list = await this.read();
    return { dir: this.dir(), checkpoints: list.length, bytes: blobBytes(list) };
  }

  /**
   * Removes checkpoints past the limits now (also done after every capture).
   *
   * @returns How many were removed and the size after.
   */
  prune(): Promise<{ removed: number; bytes: number }> {
    return this.serial(async () => this.pruneNow(await this.read()));
  }

  /** Prunes a list read under the lock: by age, then the oldest until under the size; then unused blobs go. */
  private async pruneNow(list: GameCheckpoint[]): Promise<{ removed: number; bytes: number }> {
    const keep = pruneList(list, this.limits(), Date.now());
    const removed = list.length - keep.length;
    if (removed) {
      await this.write(keep);
      await this.dropUnused(keep);
    }
    return { removed, bytes: blobBytes(keep) };
  }

  /** Deletes blobs no checkpoint uses. */
  private async dropUnused(list: GameCheckpoint[]): Promise<void> {
    const used = new Set(list.flatMap((c) => c.files.map((f) => f.blob).filter((b): b is string => !!b)));
    const root = join(this.dir(), "blobs");
    for (const sub of await readdir(root).catch(() => [] as string[])) {
      if (sub === "tmp") continue;
      for (const name of await readdir(join(root, sub)).catch(() => [] as string[])) {
        if (!used.has(name)) await rm(join(root, sub, name), { force: true }).catch(() => undefined);
      }
    }
  }
}

/**
 * The size of the contents a list of checkpoints keeps (each content once).
 *
 * @param list - The checkpoints.
 */
export function blobBytes(list: GameCheckpoint[]): number {
  let n = 0;
  for (const v of sizesOf(list).values()) n += v;
  return n;
}

/** Each content's size, once per content (the newest listing wins, as before). */
function sizesOf(list: GameCheckpoint[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const c of list) for (const f of c.files) if (f.blob) seen.set(f.blob, f.size);
  return seen;
}

/**
 * The checkpoints to keep under the limits: none older than `days`, then the oldest dropped until the size fits.
 *
 * @param list - The checkpoints, oldest first.
 * @param limits - Days and size.
 * @param now - The time now (ms).
 */
export function pruneList(list: GameCheckpoint[], limits: CheckpointLimits, now: number): GameCheckpoint[] {
  const days = Math.max(1, limits.days);
  const keep = list.filter((c) => now - Date.parse(c.at) <= days * 86_400_000);
  const max = Math.max(1, limits.maxMB) * 1024 * 1024;
  // How many kept checkpoints use each content, and their total once each: dropping the oldest only takes off the
  // contents no newer one shares (one pass, not the whole sum again per drop: up to 2,000 checkpoints).
  const uses = new Map<string, number>();
  for (const c of keep) for (const f of c.files) if (f.blob) uses.set(f.blob, (uses.get(f.blob) ?? 0) + 1);
  const sizes = sizesOf(keep);
  let bytes = 0;
  for (const v of sizes.values()) bytes += v;
  let drop = 0;
  // The newest one always stays, even when it alone is over the size (it guards the latest change).
  while (keep.length - drop > 1 && bytes > max) {
    for (const f of keep[drop]!.files) {
      if (!f.blob) continue;
      const n = uses.get(f.blob)! - 1;
      uses.set(f.blob, n);
      if (n === 0) bytes -= sizes.get(f.blob) ?? 0;
    }
    drop++;
  }
  return drop ? keep.slice(drop) : keep;
}
