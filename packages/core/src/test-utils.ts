import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Why a symlink test is skipped (shown in the test report). */
export const NO_SYMLINK = "symlinks need Developer Mode (or an administrator) on Windows";

let cached: Promise<boolean> | undefined;

/**
 * Whether this machine lets a test create a symlink. Windows without Developer Mode refuses with EPERM (or EACCES);
 * Linux, macOS and the Windows CI runner allow it. Probed once, in a temp folder that is removed again. Tests only.
 */
export function canSymlink(): Promise<boolean> {
  cached ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "kesher-symlink-probe-"));
    try {
      await writeFile(join(dir, "target"), "");
      await symlink(join(dir, "target"), join(dir, "link"));
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return false;
      throw e;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return cached;
}
