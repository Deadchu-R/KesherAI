import type { FastifyInstance } from "fastify";
import { extname } from "node:path";
import { documentText, pptxSlides, xlsxSheets } from "@kesher/agent";
import { MAX_COLS, MAX_ROWS, addr, csvCells } from "@kesher/shared";
import type { DocStore } from "../docs.js";
import type { DeckStore } from "../decks.js";
import type { SheetStore } from "../sheets.js";

const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

/**
 * Other programs' files as KesherAI's own (canvas documents, "others as options"): a Word, PDF, Markdown or text file
 * into a document, a PowerPoint into slides (each slide's first line its title, the rest its points), an Excel or CSV
 * into a sheet. Only the text comes in; the file is not kept.
 *
 * @param app - Fastify instance.
 * @param stores - The documents, decks and sheets.
 */
export async function importRoutes(app: FastifyInstance, stores: { docs: DocStore; decks: DeckStore; sheets: SheetStore }): Promise<void> {
  app.post<{ Body: { name?: string; data?: string } }>("/api/import", { bodyLimit: 45 * 1024 * 1024 }, async (req) => {
    const name = String(req.body?.name ?? "file").slice(0, 200);
    const data = Buffer.from(String(req.body?.data ?? ""), "base64");
    if (!data.length) throw bad("The file is empty.");
    if (data.length > 30 * 1024 * 1024) throw bad("The file is larger than 30 MB.");
    const ext = extname(name).toLowerCase();
    const title = name.replace(/\.[^.]+$/, "").slice(0, 160) || "Imported";
    if (ext === ".pptx") {
      const slides = pptxSlides(data).slice(0, 80).map((t, i) => {
        const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
        return { id: `s${i + 1}`, layout: i === 0 ? "title" : "bullets", title: lines[0] ?? "", bullets: lines.slice(1, 8) };
      });
      if (!slides.length) throw bad("No slides were found in this file.");
      const d = await stores.decks.create({ title, slides });
      return { kind: "slides", id: d.id, hash: `#/slides/${d.id}` };
    }
    if (ext === ".xlsx" || ext === ".csv") {
      let cells: Record<string, string>;
      if (ext === ".csv") cells = csvCells(data.toString("utf8").replace(/^\uFEFF/, "").slice(0, 6_000_000));
      else {
        const sheet = xlsxSheets(data, MAX_ROWS)[0];
        if (!sheet) throw bad("No sheet was found in this file.");
        cells = {};
        sheet.rows.slice(0, MAX_ROWS).forEach((row, r) => row.slice(0, MAX_COLS).forEach((v, c) => { if (v !== "") cells[addr(c, r)] = v.slice(0, 2000); }));
      }
      const s = await stores.sheets.create({ title, cells });
      return { kind: "sheet", id: s.id, hash: `#/sheets/${s.id}` };
    }
    if ([".docx", ".pdf", ".md", ".txt"].includes(ext)) {
      const body = ext === ".md" || ext === ".txt" ? data.toString("utf8") : (await documentText(data, name)).pages.map((p) => p.trim()).filter(Boolean).join("\n\n");
      if (!body.trim()) throw bad(ext === ".pdf" ? "This PDF has no text in it (a scan)." : "The file has no text.");
      const d = await stores.docs.create({ title, body: body.slice(0, 2 * 1024 * 1024) });
      return { kind: "doc", id: d.id, hash: `#/docs/${d.id}` };
    }
    throw bad("This kind of file cannot be brought in: Word, PDF, Markdown or text for a document; PowerPoint for slides; Excel or CSV for a sheet.");
  });
}
