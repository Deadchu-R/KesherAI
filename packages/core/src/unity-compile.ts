import { open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Whether the KesherAI Unity package compiled in a project (Roee, 2026-11-21): the page offers "Convert with AI"
 * when it did not (docs/WORK_LIST.md, Game engines). Unity's CLI cannot say it, and a package that does not compile
 * cannot report itself, so two signals are read from disk (no Unity needed, works from the phone too):
 *
 * - **Good:** the package's own `[InitializeOnLoad]` writes `Temp/KesherBridge.ok` (its version) after a domain reload.
 *   A marker of an older version is not trusted: when the new version fails to compile, Unity keeps the old assemblies.
 * - **Bad:** the Editor's log has `error CSxxxx` lines in a `com.kesherai.bridge` path, and the log is newer than the
 *   package's files (so an error from before the package was replaced does not count).
 */

/** The package's folder name in `Packages/`. */
export const BRIDGE_PACKAGE = "com.kesherai.bridge";

/** The marker the package writes into the project's `Temp/` after a successful domain reload. */
export const OK_MARKER = "KesherBridge.ok";

/** How much of the log's end is searched (a long session's log is large). */
const TAIL_BYTES = 2 * 1024 * 1024;
/** How much of the log's start says which project it belongs to. */
const HEAD_BYTES = 32 * 1024;

/**
 * The compile errors of the KesherAI package in an Editor log: lines such as
 * `Packages/com.kesherai.bridge/Editor/KesherGraph.cs(41,17): error CS0246: The type …` (also the package cache's
 * `Library/PackageCache/com.kesherai.bridge@0.2.13/…`). Only the package's own errors, without the path before the
 * package (so no personal folder), each once, in order.
 *
 * @param log - The log's text.
 * @param max - The most lines to return (default 8).
 * @returns e.g. `Editor/KesherGraph.cs(41,17): error CS0246: The type …`.
 */
export function unityCompileErrors(log: string, max = 8): string[] {
  const re = /(?:Packages[\\/]|Library[\\/]PackageCache[\\/])com\.kesherai\.bridge(?:@[^\\/\s]*)?[\\/]([^\s(]+\.cs\(\d+,\d+\): error CS\d+: .*)$/;
  const seen = new Set<string>();
  for (const line of log.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) seen.add(m[1]!.replace(/\\/g, "/").trim().slice(0, 300));
    if (seen.size >= max) break;
  }
  return [...seen];
}

/**
 * Where Unity writes the Editor's log.
 *
 * @param platform - The operating system (default this one).
 * @param env - The environment (default this one).
 * @param home - The home folder (default this user's).
 */
export function editorLogPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Unity", "Editor", "Editor.log");
  if (platform === "darwin") return join(home, "Library", "Logs", "Unity", "Editor.log");
  return join(home, ".config", "unity3d", "Editor.log");
}

/** A path in the one form the comparison uses: forward slashes, lower case, no trailing slash. */
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * Whether the start of an Editor log is a session of this project (the log holds one editor session, the last
 * one, which may be another project's): its command line has `-projectPath <folder>`, and it says
 * `Successfully changed project path to: <folder>`.
 *
 * @param head - The log's first lines.
 * @param project - The project folder.
 */
export function logIsFor(head: string, project: string): boolean {
  return norm(head).includes(norm(project));
}

/** What is known about the package in one project. */
export interface UnityCompile {
  /** ok: it ran in Unity; failed: errors in the package; unknown: not yet opened since it was added (or no package). */
  state: "ok" | "failed" | "unknown";
  /** The package's compile errors (state failed). */
  errors: string[];
  /** The package version in the project, when there is one. */
  version?: string;
}

/** Where things are read from (replaced in tests). */
export interface CompileDeps {
  /** The Editor log's path. */
  log?: string;
}

/** The first and the last bytes of a file, and its modification time. */
async function readEnds(file: string): Promise<{ head: string; tail: string; mtimeMs: number } | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const fh = await open(file, "r").catch(() => undefined);
  if (!fh) return undefined;
  try {
    const read = async (position: number, length: number) => {
      const buf = Buffer.alloc(Math.min(length, Math.max(0, info.size - position)));
      await fh.read(buf, 0, buf.length, position);
      return buf.toString("utf8");
    };
    return { head: await read(0, HEAD_BYTES), tail: await read(Math.max(0, info.size - TAIL_BYTES), TAIL_BYTES), mtimeMs: info.mtimeMs };
  } finally {
    await fh.close();
  }
}

/**
 * Whether the KesherAI package compiled in a Unity project.
 *
 * @param project - The Unity project folder.
 * @param deps - The log's path (tests).
 * @returns The state, the package's compile errors when it failed, and its version.
 */
export async function unityCompileState(project: string, deps: CompileDeps = {}): Promise<UnityCompile> {
  const pkgFile = join(project, "Packages", BRIDGE_PACKAGE, "package.json");
  const pkgInfo = await stat(pkgFile).catch(() => undefined);
  if (!pkgInfo) return { state: "unknown", errors: [] };
  let version = "";
  try {
    version = String((JSON.parse((await readFile(pkgFile, "utf8")).replace(/^\uFEFF/, "")) as { version?: string }).version ?? "");
  } catch {
    // An unreadable package.json: the version stays unknown.
  }
  const unknown: UnityCompile = { state: "unknown", errors: [], ...(version ? { version } : {}) };
  const marker = (await readFile(join(project, "Temp", OK_MARKER), "utf8").catch(() => "")).trim();
  if (marker && marker === version) return { state: "ok", errors: [], version };
  const ends = await readEnds(deps.log ?? editorLogPath());
  // A log from before the package's files were put there says nothing about them.
  if (!ends || ends.mtimeMs < pkgInfo.mtimeMs || !logIsFor(ends.head, project)) return unknown;
  const errors = unityCompileErrors(ends.tail);
  return errors.length ? { state: "failed", errors, ...(version ? { version } : {}) } : unknown;
}
