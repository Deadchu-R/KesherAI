import type { FastifyInstance } from "fastify";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { resolveInWorkspace } from "@kesher/agent";
import { DOCX_MIME, MAX_DOCX_BYTES } from "../docx-io.js";
import { exportDocx, importDocx, saveDocx, type DocxDeps } from "../docx-service.js";
import { readFile } from "node:fs/promises";

type P = { Params: { id: string } };

/**
 * Real Word files for the documents: bring a .docx in (a path in an allowed folder, or an upload), download a document
 * as .docx, and save it back over the file it came from.
 *
 * @param app - Fastify instance.
 * @param deps - The documents, pictures and allowed folders.
 * @param chatFolder - The folder of a chat (for a .docx file in it, named by chat id and relative path: the phone never
 *   sends a path on the computer); undefined when there is no such chat.
 */
export async function docxRoutes(app: FastifyInstance, deps: DocxDeps, chatFolder?: (convId: string) => Promise<string | undefined>): Promise<void> {
  /**
   * Body `{ path }`, `{ name, data }` (base64) or `{ convId, file }` (a .docx in the chat's folder, by its relative
   * path). Answers the new document; `path` is there when it will save back to its file. A chat file that lies outside
   * the allowed folders is imported without a file to save back to.
   */
  app.post<{ Body: { path?: string; name?: string; data?: string; convId?: string; file?: string } }>("/api/docs/import-docx", { bodyLimit: 45 * 1024 * 1024 }, async (req) => {
    const b = req.body ?? {};
    let d;
    if (typeof b.convId === "string" && typeof b.file === "string") {
      const root = await chatFolder?.(b.convId);
      if (!root) throw Object.assign(new Error("Conversation not found"), { statusCode: 404 });
      const full = await resolveInWorkspace(root, b.file).catch((e: Error) => { throw Object.assign(e, { statusCode: 400 }); });
      if (extname(full).toLowerCase() !== ".docx") throw Object.assign(new Error("Not a .docx file."), { statusCode: 400 });
      const st = await stat(full).catch(() => undefined);
      if (!st?.isFile()) throw Object.assign(new Error("File not found"), { statusCode: 404 });
      if (st.size > MAX_DOCX_BYTES) throw Object.assign(new Error("The file is larger than 30 MB."), { statusCode: 400 });
      // A file in one of the person's folders keeps its place (Save to Word writes back); a chat-only copy does not.
      d = await importDocx(deps, { path: full }).catch(async (e: { statusCode?: number }) => {
        if (e.statusCode !== 403) throw e;
        return importDocx(deps, { name: basename(full), data: new Uint8Array(await readFile(full)) });
      });
    } else if (typeof b.path === "string" && b.path) d = await importDocx(deps, { path: b.path });
    else {
      const data = Buffer.from(String(b.data ?? ""), "base64");
      if (!data.length) throw Object.assign(new Error("Give a path or the file."), { statusCode: 400 });
      d = await importDocx(deps, { name: String(b.name ?? "Document").slice(0, 200), data: new Uint8Array(data) });
    }
    return { id: d.id, title: d.title, hash: `#/docs/${d.id}`, ...(d.source ? { path: d.source.path } : {}) };
  });
  app.get<P>("/api/docs/:id/export.docx", async (req, reply) => {
    const d = await deps.docs.get(req.params.id);
    if (!d) return reply.code(404).send({ error: "No such document." });
    const name = `${[...d.title].filter((c) => c >= " " && !'\\/:*?"<>|'.includes(c)).join("").trim().slice(0, 80) || "Document"}.docx`;
    return reply
      .header("content-type", DOCX_MIME)
      .header("content-disposition", `attachment; filename="document.docx"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(Buffer.from(await exportDocx(deps, d)));
  });
  /** Body `{ path? }`: the file it came from when left out. */
  app.post<P & { Body: { path?: string } }>("/api/docs/:id/save-docx", async (req) => saveDocx(deps, req.params.id, typeof req.body?.path === "string" ? req.body.path : undefined));
}
