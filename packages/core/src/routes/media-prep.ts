import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { checkMediaEdit, mediaEditToFfmpeg, type MediaSource } from "@kesher/shared";
import { resolveInWorkspace } from "@kesher/agent";
import type { KesherServices } from "../services.js";
import { ensureFfmpeg } from "../ffmpeg.js";
import { checkLook, exportArgs, progressOf } from "../media-export.js";
import { ffmpegRunner, isPrepId, mediaKey, parseByteRange, prepare, readDone, type PrepRunner, type PrepStatus } from "../media-prep.js";

/** Tests put a fake FFmpeg here; nothing else touches it. */
export const media: { runner?: PrepRunner } = {};

/** The parts of a prepared file, with how each is sent. */
const PARTS: Record<string, { files: Array<[string, string]> }> = {
  proxy: { files: [["proxy.mp4", "video/mp4"], ["proxy.m4a", "audio/mp4"]] },
  sprite: { files: [["sprite.jpg", "image/jpeg"]] },
  "sprite.json": { files: [["sprite.json", "application/json"]] },
  peaks: { files: [["peaks.bin", "application/octet-stream"]] },
};

/**
 * The phone editor's media prep (see `media-prep.ts`): `POST /api/media/prep` (a chat's `conversation` + `path`, or a made file's `asset` id) starts (or finds in the cache) the prep
 * of one file of a chat's folder; `GET /api/media/prep/:id` is its status; `GET /api/media/:id/(proxy|sprite|sprite.json|peaks)`
 * send the parts, with HTTP Range. Only this PC's own data folder is read; a path is checked against the chat's folder
 * as the other file routes do, and an id is a hash, never a path. From the phone these go through the usual device key.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function mediaPrepRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const root = join(s.paths.root, "media-prep");
  const jobs = new Map<string, PrepStatus>();
  /** One file at a time: FFmpeg already uses the whole machine. */
  let tail: Promise<unknown> = Promise.resolve();
  const dirOf = (id: string): string => join(root, id);

  app.post<{ Body: { conversation?: string; path?: string; asset?: string } }>("/api/media/prep", async (req, reply) => {
    let full: string;
    if (req.body?.asset) {
      // A made video or sound (not in a chat's folder yet): its own file in the asset store, found by id.
      const rec = await s.assets.recordOf(String(req.body.asset));
      if (!rec) return reply.code(404).send({ error: "Asset not found" });
      full = s.assets.fileOf(rec);
    } else {
      const c = await s.library.getConversation(String(req.body?.conversation ?? ""));
      const folder = c ? s.conversations.workspaceOf(c) : undefined;
      if (!folder) return reply.code(404).send({ error: "Conversation not found" });
      try {
        full = await resolveInWorkspace(folder, req.body?.path ?? "");
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
    if (!(await stat(full).catch(() => undefined))?.isFile()) return reply.code(404).send({ error: "File not found" });
    const id = await mediaKey(full);
    // The id stands for this file: kept on the PC so an export can find it by id (the phone never names a path).
    await mkdir(dirOf(id), { recursive: true });
    await writeFile(join(dirOf(id), "source.txt"), full, "utf8");
    const hit = await readDone(dirOf(id), id);
    if (hit) return hit;
    const running = jobs.get(id);
    if (running && running.state !== "error") return running;
    const first: PrepStatus = { id, state: "queued", ready: { proxy: false, sprite: false, peaks: false } };
    jobs.set(id, first);
    tail = tail.then(async () => {
      try {
        const r = media.runner ?? ffmpegRunner(await ensureFfmpeg({ dir: s.paths.engines, downloads: s.downloads }));
        jobs.set(id, await prepare(r, full, dirOf(id), id, (st) => jobs.set(id, st)));
      } catch (err) {
        jobs.set(id, { ...(jobs.get(id) ?? first), state: "error", error: (err as Error).message });
      }
    });
    return first;
  });

  app.get<{ Params: { id: string } }>("/api/media/prep/:id", async (req, reply) => {
    if (!isPrepId(req.params.id)) return reply.code(400).send({ error: "Not a prep id" });
    const st = jobs.get(req.params.id) ?? (await readDone(dirOf(req.params.id), req.params.id));
    return st ?? reply.code(404).send({ error: "Not prepared" });
  });

  app.get<{ Params: { id: string; part: string } }>("/api/media/:id/:part", async (req, reply) => {
    const part = PARTS[req.params.part];
    if (!part || !isPrepId(req.params.id)) return reply.code(400).send({ error: "Unknown part" });
    for (const [name, mime] of part.files) {
      const file = join(dirOf(req.params.id), name);
      const size = (await stat(file).catch(() => undefined))?.size;
      if (size === undefined) continue;
      reply.header("accept-ranges", "bytes").header("cache-control", "private, max-age=31536000, immutable").type(mime);
      const range = parseByteRange(req.headers.range, size);
      if (range === "bad") return reply.code(416).header("content-range", `bytes */${size}`).send();
      if (!range) return reply.header("content-length", size).send(createReadStream(file));
      return reply.code(206).header("content-range", `bytes ${range.start}-${range.end}/${size}`).header("content-length", range.end - range.start + 1).send(createReadStream(file, range));
    }
    return reply.code(404).send({ error: "Not ready" });
  });

  /** The renders of the phone editor: one at a time (FFmpeg uses the whole machine), the last few kept for polling. */
  const exports = new Map<string, { state: "running" | "done" | "error"; progress: number; path?: string; error?: string }>();
  let exporting = false;

  /**
   * `POST /api/media/export` `{ conversation, sources: [prepId], edit, height?, fps?, quality? }`: renders the edit
   * list on the ORIGINAL files into the chat's `shared/` folder. Sources are prep ids (hashes), never paths.
   * Answers `{ job }`; `GET /api/media/export/:job` follows it and ends with the file's path in the chat.
   */
  type ExportBody = { conversation?: string; sources?: unknown; edit?: unknown; height?: number; fps?: number; quality?: string };
  const startExport = async (body: ExportBody, reply: FastifyReply) => {
    const c = await s.library.getConversation(String(body?.conversation ?? ""));
    const folder = c ? s.conversations.workspaceOf(c) : undefined;
    if (!folder) return reply.code(404).send({ error: "Conversation not found" });
    const ids = body?.sources;
    if (!Array.isArray(ids) || !ids.length || ids.length > 24 || !ids.every((x) => typeof x === "string" && isPrepId(x))) return reply.code(400).send({ error: "Send the prepared files' ids as sources." });
    const files: MediaSource[] = [];
    let first = "";
    let firstLength = 0;
    for (const id of ids as string[]) {
      const file = await readFile(join(dirOf(id), "source.txt"), "utf8").catch(() => "");
      if (!file || !(await stat(file).catch(() => undefined))?.isFile()) return reply.code(404).send({ error: "A source file is gone; open it again." });
      const st = await readDone(dirOf(id), id);
      if (!first) [first, firstLength] = [file, st?.duration ?? 0];
      files.push({ file, audio: st ? !!st.ready.peaks : true });
    }
    let graph;
    try {
      graph = mediaEditToFfmpeg(checkMediaEdit(body?.edit, files.length), files);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (exporting) return reply.code(429).send({ error: "Another export is running; try again when it is done." });
    exporting = true;
    const dir = join(folder, "shared");
    await mkdir(dir, { recursive: true });
    const base = (basename(first).replace(/\.[^.]+$/, "") + "-edit").replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 100);
    const ext = graph.video ? "mp4" : "m4a";
    let out = join(dir, `${base}.${ext}`);
    for (let i = 2; existsSync(out); i++) out = join(dir, `${base} (${i}).${ext}`);
    const job = randomUUID();
    exports.set(job, { state: "running", progress: 0 });
    while (exports.size > 20) exports.delete(exports.keys().next().value as string);
    // A sound-only edit has no picture length: the first file's length stands in for the progress.
    const total = graph.duration || firstLength;
    void (async () => {
      try {
        const r = media.runner ?? ffmpegRunner(await ensureFfmpeg({ dir: s.paths.engines, downloads: s.downloads }));
        await r.stream(exportArgs(graph, out, checkLook(body)), (chunk) => {
          const p = progressOf(Buffer.from(chunk).toString("utf8"), total);
          if (p !== undefined) exports.set(job, { state: "running", progress: p });
        });
        exports.set(job, { state: "done", progress: 1, path: relative(folder, out).split(sep).join("/") });
      } catch (err) {
        exports.set(job, { state: "error", progress: 0, error: (err as Error).message });
      } finally {
        exporting = false;
      }
    })();
    return { job };
  };
  app.post<{ Body: ExportBody }>("/api/media/export", (req, reply) => startExport(req.body, reply));

  /**
   * `POST /api/media/trim` `{ conversation, source: prepId, start, end }`: the sound panel's "Trim to range". Builds a
   * one-lane `SoundOp` edit (`trim` a..b) and renders it through the same export (ids only, one at a time); the result
   * is a new file in `shared/` (`GET /api/media/export/:job` follows it), the original is never touched.
   */
  app.post<{ Body: { conversation?: string; source?: unknown; start?: unknown; end?: unknown } }>("/api/media/trim", (req, reply) => {
    const { start, end } = req.body ?? {};
    if (typeof start !== "number" || typeof end !== "number") return reply.code(400).send({ error: "Send the start and the end of the range in seconds." });
    const edit = { v: 1, video: [], lanes: [{ src: 0, start: 0, ops: [{ op: "trim", a: start, b: end }] }] };
    return startExport({ conversation: req.body?.conversation, sources: [req.body?.source], edit }, reply);
  });

  app.get<{ Params: { job: string } }>("/api/media/export/:job", async (req, reply) => exports.get(req.params.job) ?? reply.code(404).send({ error: "No such export" }));
}
