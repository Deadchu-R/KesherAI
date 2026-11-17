import { rename } from "node:fs/promises";

const BUSY = ["EPERM", "EBUSY", "EACCES"];

/**
 * Puts a finished temporary file in place of the real one. Windows refuses to replace a file another reader has open
 * at that moment (EPERM / EBUSY), so it tries again a few times before giving up.
 *
 * @param tmp - The finished temporary file.
 * @param file - The file it replaces.
 */
export async function replaceFile(tmp: string, file: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, file);
      return;
    } catch (e) {
      if (i >= 20 || !BUSY.includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      await new Promise((ok) => setTimeout(ok, 25 + i * 25));
    }
  }
}
