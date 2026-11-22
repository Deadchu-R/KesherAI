import type { FastifyInstance } from "fastify";
import { EDITOR_CHUNK_MAX, saveUploadPiece, UploadRefused } from "../editor-upload.js";

/**
 * A file the editors opened from the computer or the phone, sent in pieces so a big one (a video, a scan) does not
 * need one huge request. Raw bytes of one piece in the body; `?name=&upload=&index=&total=&size=`. The last piece
 * answers `{ done: true, name }`, the others `{ done: false }`. Type and size are checked in `editor-upload.ts`.
 *
 * @param app - The server.
 * @param folderOf - The chat's folder, or undefined when it has none.
 */
export async function editorUploadRoutes(app: FastifyInstance, folderOf: (conversationId: string) => Promise<string | undefined>): Promise<void> {
  app.post<{ Params: { id: string }; Querystring: { name?: string; upload?: string; index?: string; total?: string; size?: string } }>(
    "/api/conversations/:id/files/piece",
    { bodyLimit: EDITOR_CHUNK_MAX },
    async (req, reply) => {
      const folder = await folderOf(req.params.id);
      if (!folder) return reply.code(404).send({ error: "This chat has no folder." });
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: "Send the piece's bytes as application/octet-stream." });
      const q = req.query;
      try {
        const r = await saveUploadPiece({ folder, id: String(q.upload ?? ""), index: Number(q.index), total: Number(q.total), name: String(q.name ?? ""), size: Number(q.size), bytes: body });
        return r.done ? { done: true, name: r.name } : { done: false };
      } catch (e) {
        if (e instanceof UploadRefused) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
    },
  );
}
