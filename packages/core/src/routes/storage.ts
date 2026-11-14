import { spawn } from "node:child_process";
import { stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { ensureFfmpeg } from "../ffmpeg.js";
import { moveToTrash, Storage, type StorageFile } from "../storage.js";

/** A video being made smaller, and the ones done. */
interface CompressState {
  running?: { id: string; name: string; percent: number };
  queue: string[];
  done: Array<{ original: StorageFile; result: StorageFile; saved: number }>;
  failed: Array<{ name: string; error: string }>;
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
  app.get("/api/storage/apps", async () => storage.listApps());
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
    const output = join(dirname(input), `${basename(input, extname(input))}.compressed.mp4`);
    try {
      const ffmpeg = await ensureFfmpeg({ dir: s.paths.engines, downloads: s.downloads });
      const before = (await stat(input)).size;
      await new Promise<void>((done, fail) => {
        const p = spawn(ffmpeg, ["-hide_banner", "-y", "-i", input, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx265", "-crf", "28", "-preset", "fast", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output], { windowsHide: true });
        let total = 0;
        let tail = "";
        p.stderr.on("data", (d: Buffer) => {
          const t = d.toString();
          tail = (tail + t).slice(-2000);
          const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(t);
          if (dur) total = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
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
      const original = await storage.add(input);
      const result = await storage.add(output);
      if (original && result) compress.done.unshift({ original, result, saved: before - after });
      compress.done = compress.done.slice(0, 20);
    } catch (err) {
      await unlink(output).catch(() => undefined);
      compress.failed.unshift({ name, error: (err as Error).message.slice(0, 300) });
      compress.failed = compress.failed.slice(0, 10);
    } finally {
      compress.running = undefined;
      void next();
    }
  };
  app.get("/api/storage/compress", async () => compress);
  app.post<{ Body: { ids?: unknown } }>("/api/storage/compress", async (req, reply) => {
    const ids = (Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : []).filter((id) => storage.pathOf(id));
    if (!ids.length) return reply.code(400).send({ error: "Nothing chosen (or scan again)." });
    for (const id of ids.slice(0, 50)) if (!compress.queue.includes(id) && compress.running?.id !== id) compress.queue.push(id);
    void next();
    return compress;
  });
}
