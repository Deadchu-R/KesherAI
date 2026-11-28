import { withToken } from "./api";
import { wordExportPath } from "./word-file";

/**
 * Downloads a KesherAI document as a real Word file: the server writes it (headings, lists, tables, pictures,
 * right-to-left), so the file is the same from the computer and the phone, and nothing is built in the page.
 *
 * @param id - The document's id.
 */
export function downloadDocx(id: string): void {
  const a = document.createElement("a");
  a.href = withToken(wordExportPath(id));
  a.download = "";
  a.click();
}
