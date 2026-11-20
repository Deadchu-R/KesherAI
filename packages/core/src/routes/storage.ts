import { spawn } from "node:child_process";
import { stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { ensureFfmpeg } from "../ffmpeg.js";
import { moveToTrash, parseDuration, Storage, type CompressedOriginal, type StorageFile } from "../storage.js";
import { findGamesAndStoreApps } from "../pc-games.js";
import { cleanSpotsNow, measureSpots } from "../pc-clean.js";
import { clearUpdateCache, closeProgram, emptyRecycleBin, memoryPrograms, recycleBin, startupPrograms, updateCacheBytes } from "../pc-boost.js";
import { localCall } from "../local-call.js";

/** A video being made smaller, and the ones done. */
interface CompressState {
  running?: { id: string; name: string; percent: number };
  queue: string[];
  done: Array<{ original: StorageFile; result: StorageFile; saved: number }>;
  failed: Array<{ name: string; error: string }>;
}

/**
 * A media file's length in seconds, from ffmpeg opening it (no output is written), or undefined when it does not
 * open as media.
 *
 * @param ffmpeg - The ffmpeg program.
 * @param path - The file.
 */
function mediaLength(ffmpeg: string, path: string): Promise<number | undefined> {
  return new Promise((done) => {
    let text = "";
    const p = spawn(ffmpeg, ["-hide_banner", "-i", path], { windowsHide: true });
    p.stderr.on("data", (d: Buffer) => (text = (text + d.toString()).slice(-8000)));
    p.once("error", () => done(undefined));
    p.once("close", () => done(parseDuration(text)));
  });
}

/**
 * Storage in PC Health (like Android's Storage settings and Files by Google): a scan of the person's folders, cards
 * to clean, every program with its uninstaller, and making videos smaller. Deleting goes to the Recycle Bin. Works
 * from the phone too (the owner's token; the page asks before anything is removed).
 */
export async function storageRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const storage = new Storage();
  const compress: CompressState = { queue: [], done: [], failed: [] };

  app.get<{ Querystring: { fresh?: string } }>("/api/storage", async (req) => (req.query.fresh === "1" || !storage.last ? storage.scan() : storage.last));
  app.post<{ Body: { ids?: unknown } }>("/api/storage/trash", async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : [];
    if (!ids.length) return reply.code(400).send({ error: "Nothing chosen." });
    return storage.remove(ids, moveToTrash);
  });
  /** Every compressed video's original whose smaller copy is there, whole and plays: to the bin in one press. */
  app.post("/api/storage/compress/originals/trash", async () => storage.removeOriginals(moveToTrash));
  app.get("/api/storage/apps", async () => storage.listApps());
  /** Games (Steam, Epic) and Microsoft Store / Xbox apps, which Windows' program list leaves out. */
  app.get("/api/storage/games", async () => findGamesAndStoreApps());
  /** Opens a store's own page for removing a game (it asks the person itself). Only these fixed links. */
  app.post<{ Body: { url?: string } }>("/api/storage/games/open", async (req, reply) => {
    const url = String(req.body?.url ?? "");
    if (!/^(steam:\/\/uninstall\/\d{1,10}|ms-settings:appsfeatures|ms-settings:startupapps|com\.epicgames\.launcher:\/\/store)$/.test(url)) return reply.code(400).send({ error: "Not a store link." });
    if (process.platform !== "win32") return reply.code(400).send({ error: "Only on Windows." });
    spawn("cmd.exe", ["/d", "/c", "start", '""', url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return { ok: true };
  });
  /** Speed up, the rest: the Recycle Bin, Windows Update's cache, programs holding memory, and startup programs. */
  app.get("/api/storage/boost", async () => {
    const [bin, updates, programs, startup] = await Promise.all([recycleBin(), updateCacheBytes(), memoryPrograms(), startupPrograms()]);
    return { bin, ...(updates !== undefined ? { updateCache: updates } : {}), programs, startup };
  });
  app.post("/api/storage/recycle-bin/empty", async () => ({ ok: await emptyRecycleBin() }));
  /** Windows shows its own administrator prompt on the computer; nothing runs unless the person accepts it there. */
  app.post("/api/storage/update-cache/clear", async () => clearUpdateCache());
  app.post<{ Body: { name?: string; force?: boolean } }>("/api/storage/close", async (req) => closeProgram(String(req.body?.name ?? ""), req.body?.force === true));
  /** KesherAI's own models out of memory and the graphics card (they load again when a chat needs them). */
  app.post("/api/storage/free-models", async () => {
    await Promise.all([localCall(s.config.port, "POST", "/api/engines/llamacpp/stop").catch(() => undefined), localCall(s.config.port, "POST", "/api/engines/beside/stop").catch(() => undefined)]);
    return { ok: true };
  });
  /** Performance boost: caches and temporary files, measured; cleaned only where the person ticked. */
  app.get("/api/storage/clean", async () => ({ spots: await measureSpots() }));
  app.post<{ Body: { ids?: unknown } }>("/api/storage/clean", async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String).slice(0, 20) : [];
    if (!ids.length) return reply.code(400).send({ error: "Nothing chosen." });
    return cleanSpotsNow(ids);
  });
  app.post<{ Body: { id?: string } }>("/api/storage/apps/uninstall", async (req, reply) => {
    try {
      await storage.uninstall(String(req.body?.id ?? ""));
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Making videos smaller: H.265 (HEVC) at a quality that looks the same on a phone or a laptop screen, usually a
  // half to a third of the size. A new file "<name>.compressed.mp4" is made next to the original, which stays until
  // the person moves it to the bin. One at a time.
  const next = async (): Promise<void> => {
    if (compress.running) return;
    const id = compress.queue.shift();
    if (!id) return;
    const input = storage.pathOf(id);
    if (!input) return next();
    const name = basename(input);
    compress.running = { id, name, percent: 0 };
    // A new name when that one is taken: a file of the person's is never written over.
    let output = join(dirname(input), `${basename(input, extname(input))}.compressed.mp4`);
    for (let i = 2; await stat(output).then(() => true, () => false); i++) output = join(dirname(input), `${basename(input, extname(input))}.compressed-${i}.mp4`);
    try {
      const ffmpeg = await ensureFfmpeg({ dir: s.paths.engines, downloads: s.downloads });
      const before = (await stat(input)).size;
      let total = 0;
      await new Promise<void>((done, fail) => {
        const p = spawn(ffmpeg, ["-hide_banner", "-n", "-i", input, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx265", "-crf", "28", "-preset", "fast", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output], { windowsHide: true });
        let tail = "";
        p.stderr.on("data", (d: Buffer) => {
          const t = d.toString();
          tail = (tail + t).slice(-2000);
          total = parseDuration(t) ?? total;
          const at = /time=(\d+):(\d+):([\d.]+)/.exec(t);
          if (at && total && compress.running) compress.running.percent = Math.min(99, Math.round(((Number(at[1]) * 3600 + Number(at[2]) * 60 + Number(at[3])) / total) * 100));
        });
        p.once("error", fail);
        p.once("close", (code) => (code === 0 ? done() : fail(new Error(tail.split("\n").filter(Boolean).slice(-1)[0] ?? `ffmpeg stopped (${code})`))));
      });
      const after = (await stat(output)).size;
      if (after > before * 0.85) {
        await unlink(output).catch(() => undefined);
        throw new Error("It is already compact; a smaller copy would not save much.");
      }
      // The copy must open as a video and play nearly to the original's end (streams it leaves out, like subtitles,
      // can make the original a little longer), else it is not kept.
      const length = await mediaLength(ffmpeg, output);
      if (length === undefined || (total && length < total * 0.9 - 1)) throw new Error("The smaller copy did not come out whole; the original stays.");
      const pair = await storage.addCompressed(input, output, true);
      if (pair) compress.done.unshift({ ...pair, saved: before - after });
      compress.done = compress.done.slice(0, 100);
    } catch (err) {
      await unlink(output).catch(() => undefined);
      compress.failed.unshift({ name, error: (err as Error).message.slice(0, 300) });
      compress.failed = compress.failed.slice(0, 10);
    } finally {
      compress.running = undefined;
      void next();
    }
  };
  /** The compressions, with where each original stands (gone, or ready to go to the bin with the others). */
  app.get("/api/storage/compress", async () => {
    const state = await storage.compressedOriginals(compress.done.map((d) => d.original.id));
    const by = new Map<string, CompressedOriginal>(state.map((o) => [o.id, o]));
    const ready = state.filter((o) => o.ready);
    return {
      ...compress,
      done: compress.done.map((d) => ({ ...d, originalGone: by.get(d.original.id)?.gone ?? false, ready: by.get(d.original.id)?.ready ?? false })),
      originals: { count: ready.length, bytes: ready.reduce((n, o) => n + o.bytes, 0) },
    };
  });
  app.post<{ Body: { ids?: unknown } }>("/api/storage/compress", async (req, reply) => {
    const ids = (Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : []).filter((id) => storage.pathOf(id));
    if (!ids.length) return reply.code(400).send({ error: "Nothing chosen (or scan again)." });
    for (const id of ids.slice(0, 50)) if (!compress.queue.includes(id) && compress.running?.id !== id) compress.queue.push(id);
    void next();
    return compress;
  });
}
