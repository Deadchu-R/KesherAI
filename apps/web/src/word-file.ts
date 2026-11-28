/**
 * Word files in the chat (design ChatDocxSurface): which item a `docx_open` step made, the file name shown in the
 * panel's header, and the state of its "Save to Word" button. No React here, so it is tested on its own.
 */

/** What the "Save to Word" button shows: nothing to save, unsaved changes (a dot), saving now, or no file to write back to. */
export type WordSaveState = "clean" | "dirty" | "saving" | "no-file";

/**
 * The document `docx_open` made, from its result ("Opened "Plan" as document d1 (120 words). The user sees it at #/docs/d1.").
 *
 * @param tool - The tool's name; `ok` and `output` its result.
 * @returns The document's id and title, or undefined for another tool or a failure.
 */
export function wordFromResult(tool: string, ok: boolean, output: string): { kind: "word"; id: string; title: string } | undefined {
  if (tool !== "docx_open" || !ok) return undefined;
  const m = /^Opened "(.*)" as document ([\w-]{1,80})/.exec(output);
  return m ? { kind: "word", id: m[2]!, title: m[1]! } : undefined;
}

/**
 * The last part of a path of either kind (`C:\Users\x\Plan.docx` and `/home/x/Plan.docx` both give `Plan.docx`), so the
 * panel never shows a folder on the computer (the phone sees only the name).
 */
export function wordFileName(path: string | undefined): string {
  return (path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/**
 * The state of the "Save to Word" button.
 *
 * @param p - `hasFile`: the document remembers its Word file; `rev`: the document's revision now; `savedRev`: the
 *   revision last written to the file (or read from it); `saving`: a save is running.
 */
export function wordSaveState(p: { hasFile: boolean; rev: number; savedRev: number; saving: boolean }): WordSaveState {
  if (p.saving) return "saving";
  if (!p.hasFile) return "no-file";
  return p.rev === p.savedRev ? "clean" : "dirty";
}

/** The address of a document as a Word file (the server writes it: headings, lists, tables, pictures, right-to-left). */
export const wordExportPath = (id: string) => `/api/docs/${encodeURIComponent(id)}/export.docx`;
