import { statSync } from "node:fs";

/**
 * Files that are only in the cloud (OneDrive "Files On-Demand" placeholders): a project kept under OneDrive can have
 * files whose data was never downloaded. Reading one either starts a download or, when that is blocked, fails with
 * "UNKNOWN: unknown error, read" (EIO). KesherAI only reads project files to look at them, so such a file is never
 * read: it is spotted before the read where possible, else by its read error, and named in a clear message.
 *
 * The cheap check needs no extra process or native module: Windows reports a placeholder's size on disk (its
 * AllocationSize, Node's `blocks`) as 0 while its size is the real one. Node has no API for the file's attributes
 * (RECALL_ON_DATA_ACCESS / OFFLINE), and asking PowerShell per file would cost far more than the read itself.
 */

/** The message for a file that is only in the cloud (English; the page shows its own Hebrew). */
export const CLOUD_ONLY_MESSAGE = "Only in OneDrive (not downloaded)";

/**
 * Files at least this big with no space on disk are taken for placeholders. NTFS keeps very small files inside
 * their MFT record (no space of their own), so smaller files are left to the read-error check.
 */
const MIN_PLACEHOLDER_BYTES = 4096;

/** Whether Node reports `blocks` here at all (checked once on the running program's own file, which is local). */
let blocksWork: boolean | undefined;

/**
 * Whether this Node reports real sizes on disk: some file systems or Node builds give 0 or nothing for every file,
 * and then the size-on-disk check would take every file for a placeholder.
 *
 * @param probe - A local file to check with (default: the running program).
 */
function blocksReported(probe = process.execPath): boolean {
  if (blocksWork === undefined) {
    try {
      const st = statSync(probe);
      blocksWork = typeof st.blocks === "number" && st.blocks > 0;
    } catch {
      blocksWork = false;
    }
  }
  return blocksWork;
}

/**
 * Whether a file looks like a cloud-only placeholder from its stat alone (no read, so no download): on Windows, a
 * file of some size that takes no space on disk.
 *
 * @param st - The file's stat (`size` and `blocks`).
 * @param platform - The OS (default: this one).
 * @param probe - A local file used once to check that sizes on disk are reported (tests pass their own).
 * @returns True for a placeholder.
 */
export function looksCloudOnly(st: { size: number; blocks?: number }, platform: NodeJS.Platform = process.platform, probe?: string): boolean {
  if (platform !== "win32" || st.size < MIN_PLACEHOLDER_BYTES || st.blocks !== 0) return false;
  return blocksReported(probe);
}

/**
 * Whether a read error is what a cloud-only file gives on Windows (the download is blocked or failed): EIO, Node's
 * UNKNOWN, or a cloud-file error code, for a file that has a size.
 *
 * @param err - The error from the read.
 * @param size - The file's size (an empty file cannot be a placeholder).
 * @param platform - The OS (default: this one).
 * @returns True when the file should be treated as only in the cloud.
 */
export function isCloudReadError(err: unknown, size: number, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32" || size <= 0) return false;
  const code = String((err as { code?: unknown } | undefined)?.code ?? "");
  return code === "EIO" || code === "UNKNOWN" || /^ECLOUD/.test(code);
}

/** Forgets the once-per-run check (tests). */
export function resetCloudOnlyCheck(): void {
  blocksWork = undefined;
}
