/**
 * Word files and KesherAI documents together: bringing a .docx in as a document, giving a document out as a .docx,
 * saving it back over the file it came from, and the agent tools `docx_open` and `docx_save`. The conversion itself is
 * in docx-io.ts; the libraries load only when one of these runs.
 */
import type { AgentTool } from "@kesher/agent";
import type { AssetStore } from "./assets.js";
import { dataUrlImage, docxToMarkdown, markdownToDocx, readDocxFile, writeDocxFile, type LoadImage } from "./docx-io.js";
import type { Doc, DocStore } from "./docs.js";
import { userFolders } from "./storage.js";

let folders: Promise<string[]> | undefined;

/** The folders a Word file may be read from or written to: the person's own (Documents, Desktop, Downloads...). */
export function docxRoots(): Promise<string[]> {
  return (folders ??= userFolders().then((f) => f.map((x) => x.path)));
}

/** What the Word features need: the documents, the pictures and the folders a Word file may be read from or written to. */
export interface DocxDeps {
  docs: DocStore;
  assets: Pick<AssetStore, "save" | "get">;
  /** The allowed folders (asked each time; it may be cached). */
  roots: () => Promise<readonly string[]>;
}

/** Reads the pictures of a document: an asset link (`/api/assets/<id>`) or a data: address. */
function imageLoader(assets: DocxDeps["assets"]): LoadImage {
  return async (src) => {
    const m = /^\/api\/assets\/([0-9a-f-]{36})$/.exec(src);
    if (m) {
      const a = await assets.get(m[1]!);
      return a ? { data: new Uint8Array(a.data), mimeType: a.asset.mimeType } : undefined;
    }
    return dataUrlImage(src);
  };
}

/**
 * Brings a Word file in as a new document that remembers the file (for saving back).
 *
 * @param deps - The stores and allowed folders.
 * @param from - A path in an allowed folder, or an uploaded file's name and bytes.
 * @returns The new document.
 */
export async function importDocx(deps: DocxDeps, from: { path: string } | { name: string; data: Uint8Array }): Promise<Doc> {
  let data: Uint8Array;
  let title: string;
  let source: { path: string } | undefined;
  if ("path" in from) {
    const f = await readDocxFile(from.path, await deps.roots());
    ({ data, title } = f);
    source = { path: f.path };
  } else {
    data = from.data;
    title = from.name.replace(/\.[^.]+$/, "").slice(0, 160) || "Document";
  }
  const body = await docxToMarkdown(data, async (img, mimeType) => `/api/assets/${(await deps.assets.save(img, mimeType, { meta: { fromDocx: true } })).id}`);
  return deps.docs.create({ title, body: body.slice(0, 2 * 1024 * 1024), ...(source ? { source } : {}) });
}

/**
 * A document as the bytes of a real Word file.
 *
 * @param deps - The stores.
 * @param doc - The document.
 */
export function exportDocx(deps: DocxDeps, doc: Pick<Doc, "title" | "body">): Promise<Uint8Array> {
  return markdownToDocx(doc.title, doc.body, imageLoader(deps.assets));
}

/**
 * Saves a document as a Word file: over the file it came from, or at a given path (which then becomes its file).
 *
 * @param deps - The stores and allowed folders.
 * @param id - The document.
 * @param path - Where to write; leave out for the file it came from.
 * @returns The path written and whether a .bak copy of the old file was made.
 */
export async function saveDocx(deps: DocxDeps, id: string, path?: string): Promise<{ path: string; bak: boolean }> {
  const doc = await deps.docs.get(id);
  if (!doc) throw Object.assign(new Error("No such document."), { statusCode: 404 });
  const to = path || doc.source?.path;
  if (!to) throw Object.assign(new Error("This document did not come from a Word file: give the path to save to."), { statusCode: 400 });
  const done = await writeDocxFile(to, await deps.roots(), await exportDocx(deps, doc));
  if (doc.source?.path !== done.path) await deps.docs.update(id, (d) => void (d.source = { path: done.path }));
  return done;
}

/**
 * The agent tools for Word files: `docx_open` (a .docx becomes a KesherAI document the chat opens) and `docx_save`
 * (a document written as a .docx, over the original or at a new path).
 *
 * @param deps - The stores and allowed folders.
 */
export function docxTools(deps: DocxDeps): AgentTool[] {
  return [
    {
      risk: "read",
      spec: {
        name: "docx_open",
        description: "Opens a Word (.docx) file from the user's folders (Documents, Desktop, Downloads...) as a KesherAI document and returns its id; the user sees it at #/docs/<id> and can edit it. Use the document tool with that id to read or change it, then docx_save to write it back to the Word file. path: the full path of the file.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      async run(input) {
        const d = await importDocx(deps, { path: String(input.path ?? "") });
        return { output: `Opened "${d.title}" as document ${d.id} (${d.body.split(/\s+/).filter(Boolean).length} words). The user sees it at #/docs/${d.id}. Read it with the document tool (id: ${d.id}).` };
      },
    },
    {
      risk: "write",
      spec: {
        name: "docx_save",
        description: "Saves a KesherAI document as a real Word (.docx) file: over the Word file it was opened from (the old file is kept once as <name>.docx.bak), or at path (a full path in the user's folders) when it has none. doc_id: the document's id.",
        inputSchema: { type: "object", properties: { doc_id: { type: "string" }, path: { type: "string" } }, required: ["doc_id"] },
      },
      async run(input) {
        const r = await saveDocx(deps, String(input.doc_id ?? ""), typeof input.path === "string" && input.path ? input.path : undefined);
        return { output: `Saved the Word file ${r.path}${r.bak ? " (the old file is kept as .bak)" : ""}.` };
      },
    },
  ];
}
