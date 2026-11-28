import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveInWorkspace } from "@kesher/agent";
import type { KesherServices } from "../services.js";
import { ensureFfmpeg } from "../ffmpeg.js";
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
 * The phone editor's media prep (see `media-prep.ts`): `POST /api/media/prep` starts (or finds in the cache) the prep
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

  app.post<{ Body: { conversation?: string; path?: string } }>("/api/media/prep", async (req, reply) => {
    const c = await s.library.getConversation(String(req.body?.conversation ?? ""));
    const folder = c ? s.conversations.workspaceOf(c) : undefined;
    if (!folder) return reply.code(404).send({ error: "Conversation not found" });
    let full: string;
    try {
      full = await resolveInWorkspace(folder, req.body?.path ?? "");
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (!(await stat(full).catch(() => undefined))?.isFile()) return reply.code(404).send({ error: "File not found" });
    const id = await mediaKey(full);
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
}
