/**
 * Outlines of an attached folder or archive (chat step 9, RESEARCH_LOG "Chat step 9: file reading and hunk review"):
 * what is inside, as a short tree, instead of dumping every file into the model's context. The model reads the files
 * it needs afterwards with its own tools (read_file, read_document), as Claude and ChatGPT page through large inputs.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { IGNORED_DIRS, openZip } from "@kesher/agent";

/** A folder's or archive's outline. */
export interface Outline {
  /** One line per entry, indented two spaces per level; folders end with "/". */
  lines: string[];
  /** Entries left out (past the limit). */
  more: number;
  /** How many files were seen (in an archive: all of them). */
  files: number;
  /** Paths (relative, "/") of files worth reading first: a README or the project's manifest. */
  key: string[];
}

/** Files that say what a project is, read first. */
const KEY_FILE = /^(readme(\.(md|txt|rst))?|package\.json|pyproject\.toml|cargo\.toml|go\.mod|[^/]+\.(uproject|csproj|sln)|projectsettings\/projectversion\.txt)$/i;

/**
 * Walks a folder breadth-first to a few levels, skipping build and dependency folders (node_modules, .git, Library…).
 *
 * @param dir - The folder.
 * @param o.max - The most lines (default 150).
 * @param o.depth - The deepest level shown, 0 = the folder's own entries (default 3).
 * @returns The outline, folders before files at each level, names sorted.
 */
export async function folderOutline(dir: string, o: { max?: number; depth?: number } = {}): Promise<Outline> {
  const max = o.max ?? 150;
  const depth = o.depth ?? 3;
  const out: Outline = { lines: [], more: 0, files: 0, key: [] };
  // Depth-first output (a tree reads naturally), but each folder's listing is capped by the shared line budget.
  const walk = async (path: string, rel: string, level: number): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        if (out.lines.length >= max) {
          out.more++;
          continue;
        }
        out.lines.push(`${"  ".repeat(level)}${e.name}/`);
        if (level < depth) await walk(join(path, e.name), sub, level + 1);
      } else if (e.isFile()) {
        out.files++;
        if (KEY_FILE.test(sub) && out.key.length < 3) out.key.push(sub);
        if (out.lines.length >= max) {
          out.more++;
          continue;
        }
        const size = await stat(join(path, e.name)).then((s) => s.size, () => 0);
        out.lines.push(`${"  ".repeat(level)}${e.name} (${sizeText(size)})`);
      }
    }
  };
  await walk(dir, "", 0);
  return out;
}

/**
 * Lists a ZIP archive from its directory (nothing is unpacked, so a "zip bomb" costs nothing).
 *
 * @param data - The archive's bytes.
 * @param max - The most lines (default 150).
 * @returns The outline (each path on its own line, as stored), or throws when it is not a ZIP.
 */
export function zipOutline(data: Uint8Array, max = 150): Outline {
  const names = openZip(data).names.filter((n) => !n.endsWith("/") && !/(^|\/)(__MACOSX|\.git|node_modules)\//.test(n));
  const key = names.filter((n) => KEY_FILE.test(n.split("/").slice(-1)[0] ?? "") && n.split("/").length <= 2).slice(0, 3);
  return { lines: names.slice(0, max), more: Math.max(0, names.length - max), files: names.length, key };
}

/** @returns A size in short words ("12 KB", "3.4 MB"). */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
