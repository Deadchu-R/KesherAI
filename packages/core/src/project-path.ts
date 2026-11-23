import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Comparing project paths that different programs wrote differently. Unreal 4's `ConvertRelativePathToFull` answers
 * with forward slashes ("C:/Users/x/Game/Game.uproject") while the project scan uses Windows ones
 * ("C:\Users\x\Game"), and Windows paths differ by letter case only; a plain string compare then says "not the
 * same project" (the editor looked closed on the Unreal page although it was connected).
 */

/** A path that is a Windows one: a drive letter ("C:/", "c:\") or a share ("\\host\share"), or any path on Windows. */
const looksWindows = (p: string): boolean => process.platform === "win32" || /^[a-z]:[\\/]/i.test(p) || /^\\\\[^\\]/.test(p);

/**
 * One form of a path for comparing: slashes and `..` resolved, no trailing slash, and lower case for a Windows path.
 *
 * @param p - A file or folder path in any slash style.
 * @returns The comparable path ("" for an empty one).
 */
export function normalizePath(p: string): string {
  const s = String(p ?? "").trim();
  if (!s) return "";
  if (looksWindows(s)) return win32.resolve(s).replace(/[\\/]+$/, "").toLowerCase();
  return posix.resolve(s.replace(/\\/g, "/")).replace(/\/+$/, "") || "/";
}

/** The real path (links and short names resolved) when the path exists, else the path as given. */
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Whether two paths are the same place, whatever their slash style or letter case (Windows), and through links
 * (a OneDrive or junction alias of the same folder).
 *
 * @param a - A file or folder path.
 * @param b - Another one.
 */
export function samePath(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return normalizePath(real(a)) === normalizePath(real(b));
}

/**
 * The folder of a project file in either slash style (`dirname` of the running system does not split "C:/a/b.uproject"
 * the Windows way when KesherAI runs elsewhere, and keeps mixed slashes on Windows).
 *
 * @param file - A `.uproject` (or any file) path.
 */
export function folderOf(file: string): string {
  const s = String(file ?? "");
  return looksWindows(s) ? win32.dirname(win32.normalize(s)) : posix.dirname(s.replace(/\\/g, "/"));
}

/**
 * Whether an editor's project file sits in a project folder (used for the "open" marks).
 *
 * @param projectFile - The editor's reported `.uproject` (may be undefined: not open).
 * @param folder - A project folder from the scan.
 */
export function projectFileInFolder(projectFile: string | undefined, folder: string): boolean {
  return !!projectFile && samePath(folderOf(projectFile), folder);
}

/**
 * The project file in the form the system uses (Windows: backslashes), so it can be passed to programs and compared
 * as a string with the scan's paths.
 *
 * @param file - The path as the editor reported it.
 */
export function nativeProjectFile(file: string): string {
  return looksWindows(file) ? win32.normalize(file) : file;
}
