import type { FastifyInstance } from "fastify";
import { DOCX_MIME } from "../docx-io.js";
import { exportDocx, importDocx, saveDocx, type DocxDeps } from "../docx-service.js";

type P = { Params: { id: string } };

/**
 * Real Word files for the documents: bring a .docx in (a path in an allowed folder, or an upload), download a document
 * as .docx, and save it back over the file it came from.
 *
 * @param app - Fastify instance.
 * @param deps - The documents, pictures and allowed folders.
 */
export async function docxRoutes(app: FastifyInstance, deps: DocxDeps): Promise<void> {
  /** Body `{ path }` or `{ name, data }` (base64). Answers the new document. */
  app.post<{ Body: { path?: string; name?: string; data?: string } }>("/api/docs/import-docx", { bodyLimit: 45 * 1024 * 1024 }, async (req) => {
    const b = req.body ?? {};
    let d;
    if (typeof b.path === "string" && b.path) d = await importDocx(deps, { path: b.path });
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
