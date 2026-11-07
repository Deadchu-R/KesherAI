import { realpath } from "node:fs/promises";
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
  return relative(root, absolute).split(sep).join("/") || ".";
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
