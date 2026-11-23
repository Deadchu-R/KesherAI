/**
 * Finds GGUF model files under a folder, in any sub-folder and with any quantization, so a model the normal model
 * downloader saved (e.g. `chat/<author>/<repo>/<file>.gguf`) is found wherever it sits. Used by the translator and
 * by computer vision, which look for a particular family of models rather than one fixed path.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Lists the `.gguf` files under a folder, sorted by path (so the result is the same on every run).
 *
 * @param root - The folder to search (a missing folder gives an empty list).
 * @param depth - How many folder levels below `root` to look into (default 5: `kind/author/repo/file`).
 * @returns Full paths of the GGUF files. Hidden folders (starting with a dot) are skipped.
 */
export function listGgufFiles(root: string, depth = 5): string[] {
  const out: string[] = [];
  const walk = (dir: string, left: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = join(dir, e.name);
      if (e.isFile() && /\.gguf$/i.test(e.name)) out.push(p);
      else if (e.isDirectory() && left > 0 && !e.name.startsWith(".")) walk(p, left - 1);
    }
  };
  walk(root, depth);
  return out;
}
