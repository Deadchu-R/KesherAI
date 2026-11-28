import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Folders that are caches or dependencies, never searched. */
const SKIP = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "build", ".next", ".cache", "dist"]);
/** A file bigger than this is skipped (it is not source code a person reads). */
const MAX_FILE = 1024 ** 2;
const MAX_FILES = 3000;

/** One line that holds the text searched for. */
export interface SearchHit {
  /** Path inside the folder, with `/`. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** The line, cut to 200 characters. */
  text: string;
}

/**
 * Finds a text (case-insensitive, literal, not a pattern) in the text files of a folder: the code panel's "search in
 * the folder". Skips dependency and build folders, binary and very big files, and stops at `limit` hits.
 *
 * @param root - The folder (the chat's work folder).
 * @param query - The text to find (at least 2 characters).
 * @param limit - The most hits to return.
 * @returns The hits, file by file in name order.
 */
export async function searchFolder(root: string, query: string, limit = 200): Promise<SearchHit[]> {
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  if (needle.length < 2) return hits;
  let seen = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (hits.length >= limit || seen >= MAX_FILES) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      seen++;
      const st = await stat(full).catch(() => undefined);
      if (!st || st.size > MAX_FILE) continue;
      const buf = await readFile(full).catch(() => undefined);
      if (!buf || buf.includes(0)) continue;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length && hits.length < limit; i++) {
        const l = lines[i]!;
        if (l.toLowerCase().includes(needle)) hits.push({ path: relative(root, full).split(sep).join("/"), line: i + 1, text: l.trimEnd().slice(0, 200) });
      }
    }
  };
  await walk(root);
  return hits;
}
