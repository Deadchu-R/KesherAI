import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolves a path the model gave against the workspace and refuses anything
 * outside it — including `..`, absolute paths elsewhere, and symlinks that
 * point out of the folder.
 *
 * @param root - Absolute workspace folder.
 * @param path - Path from the model, relative or absolute.
 * @returns The absolute path inside the workspace.
 * @throws Error if the path leaves the workspace.
 */
export async function resolveInWorkspace(root: string, path: string): Promise<string> {
  const realRoot = await realpath(root);
  const target = resolve(realRoot, path || ".");
  assertInside(realRoot, target, path);
  // Follow symlinks of the deepest part that exists, then check again.
  let existing = target;
  for (;;) {
    try {
      const real = await realpath(existing);
      assertInside(realRoot, real, path);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  // A link whose target does not exist yet ("dangling") has no real path, and writing through it
  // would create its target, possibly outside: check every link on the way by where it points.
  const parts = relative(realRoot, target).split(sep).filter(Boolean);
  let at = realRoot;
  for (const part of parts) {
    at = resolve(at, part);
    const st = await lstat(at).catch(() => undefined);
    if (!st) break;
    if (st.isSymbolicLink()) assertInside(realRoot, resolve(dirname(at), await readlink(at)), path);
  }
  return target;
}

function assertInside(root: string, target: string, original: string): void {
  const rel = relative(root, target);
  if (rel === "") return;
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`"${original}" is outside the project folder. Only files inside ${root} can be used.`);
  }
}

/**
 * Shows a path relative to the workspace, with forward slashes, for messages.
 *
 * @param root - Workspace folder.
 * @param absolute - Absolute path inside it.
 * @returns e.g. `src/app.ts`.
 */
export function displayPath(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  // Files in a granted folder outside the project are shown with their full path.
  if (rel.startsWith("..") || isAbsolute(rel)) return absolute;
  return rel.split(sep).join("/") || ".";
}

/** Folders that are never listed or searched: they are huge and rarely relevant. */
export const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".venv", "venv", "__pycache__",
  ".cache", "target", "Library", "Temp", "Binaries", "Intermediate", "DerivedDataCache", "Saved",
]);

/**
 * Turns a glob into a regular expression. Supports `**`, `*`, `?` and
 * `{a,b}`; matching is case-insensitive so it behaves the same on Windows.
 *
 * @param glob - e.g. `src/**\/*.ts`.
 * @returns A regex matching forward-slash relative paths.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === ",") re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/**
 * Resolves a path for a file tool: inside the workspace, or inside one of
 * the folders (or files) the user granted access to in this conversation.
 *
 * @param workspace - Absolute workspace folder, if any.
 * @param extraRoots - Granted folders or files.
 * @param path - Path from the model.
 * @returns The absolute path.
 * @throws Error if the path is in none of them.
 */
export async function resolveForTool(workspace: string | undefined, extraRoots: readonly string[], path: string): Promise<string> {
  let firstError: Error | undefined;
  if (workspace) {
    try {
      return await resolveInWorkspace(workspace, path);
    } catch (err) {
      firstError = err as Error;
    }
  }
  if (isAbsolute(path)) {
    for (const root of extraRoots) {
      try {
        return await resolveInWorkspace(root, path);
      } catch {
        // try the next one
      }
    }
  }
  const granted = extraRoots.length ? ` Folders you were given: ${extraRoots.join(", ")}.` : "";
  throw new Error(`${firstError?.message ?? `"${path}" is outside the folders you can use.`}${granted} To use another folder, call request_access.`);
}
