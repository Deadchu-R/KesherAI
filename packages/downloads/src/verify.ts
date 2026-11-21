import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** The size of the blocks a verify scan looks at for holes (1 MiB). */
export const SCAN_BLOCK = 1024 ** 2;

/** Files bigger than this are checked automatically after the download (when that setting is on); smaller ones always are. */
export const AUTO_VERIFY_BYTES = 1024 ** 3;

/** A stretch of a file: bytes `start` to `end`, both included. */
export interface ByteRange {
  start: number;
  end: number;
}

/** What one pass over a file found. */
export interface FileScan {
  /** Lower-case hex SHA-256 of the whole file. */
  sha256: string;
  /** Indices of the {@link SCAN_BLOCK} blocks that are all zeros (a part that never landed leaves such holes). */
  zeroBlocks: number[];
}

/**
 * Compares a computed hash with the hub's, ignoring case and spaces.
 *
 * @param actual - The hash of the file on disk.
 * @param expected - The hash the hub gave (a 64-character hex string).
 * @returns `true` when they are the same.
 */
export function hashesMatch(actual: string, expected: string): boolean {
  const e = expected.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(e) && actual.trim().toLowerCase() === e;
}

/**
 * Reads a file once, front to back, giving its SHA-256 and which blocks are all zeros. Nothing is kept in memory
 * but the running hash, so it works on a 40 GB file.
 *
 * @param path - The file.
 * @param opts - `onProgress` gets the bytes read so far after each chunk; `signal` stops the pass (it then throws);
 * `blockSize` is for tests.
 * @returns The hash and the zero blocks.
 */
export async function scanFile(path: string, opts: { onProgress?: (bytes: number) => void; signal?: AbortSignal; blockSize?: number } = {}): Promise<FileScan> {
  const block = opts.blockSize ?? SCAN_BLOCK;
  const hash = createHash("sha256");
  const zeroBlocks: number[] = [];
  let offset = 0;
  // The block being read may straddle two chunks: remember if it is still all zeros so far.
  let blockIndex = 0;
  let blockFill = 0;
  let blockZero = true;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    if (opts.signal?.aborted) throw new Error("Stopped.");
    hash.update(chunk);
    for (let i = 0; i < chunk.length; ) {
      const take = Math.min(chunk.length - i, block - blockFill);
      if (blockZero && chunk.subarray(i, i + take).some((b) => b !== 0)) blockZero = false;
      blockFill += take;
      i += take;
      if (blockFill === block) {
        if (blockZero) zeroBlocks.push(blockIndex);
        blockIndex++;
        blockFill = 0;
        blockZero = true;
      }
    }
    offset += chunk.length;
    opts.onProgress?.(offset);
  }
  // The last, shorter block.
  if (blockFill > 0 && blockZero) zeroBlocks.push(blockIndex);
  return { sha256: hash.digest("hex"), zeroBlocks };
}

/**
 * Turns the zero blocks into the byte ranges to download again: neighbouring blocks join into one range, and the
 * last range stops at the end of the file. When the download's parts are known, a range that crosses a part's edge
 * is cut there, so the parts can be fetched at the same time like they were the first time.
 *
 * @param zeroBlocks - Block indices from {@link scanFile}, in order.
 * @param size - The file's size in bytes.
 * @param blockSize - The block size the scan used.
 * @param parts - The download's parts (their `start` and `end`), when the layout is known.
 * @returns The ranges, in order. Empty when there are no holes.
 */
export function damagedRanges(zeroBlocks: number[], size: number, blockSize = SCAN_BLOCK, parts?: ByteRange[]): ByteRange[] {
  const joined: ByteRange[] = [];
  for (const b of zeroBlocks) {
    const start = b * blockSize;
    if (start >= size) continue;
    const end = Math.min(size - 1, start + blockSize - 1);
    const last = joined[joined.length - 1];
    if (last && last.end + 1 === start) last.end = end;
    else joined.push({ start, end });
  }
  if (!parts?.length) return joined;
  const cut: ByteRange[] = [];
  for (const r of joined) {
    for (const p of parts) {
      const start = Math.max(r.start, p.start);
      const end = Math.min(r.end, p.end);
      if (start <= end) cut.push({ start, end });
    }
  }
  return cut.sort((a, b) => a.start - b.start);
}

/** How a bad file is repaired: only the broken ranges, or the whole file again. */
export type RepairPlan = { kind: "ranges"; ranges: ByteRange[]; bytes: number } | { kind: "whole" };

/**
 * Decides how to repair a file whose hash did not match. Only a file that was downloaded in parts (the layout is
 * known) and shows holes is repaired by ranges; anything else, and a file where the holes are most of it, is
 * downloaded again whole.
 *
 * @param zeroBlocks - Block indices from {@link scanFile}.
 * @param size - The file's size in bytes.
 * @param parts - The download's parts, or `undefined` when it was one stream (or the layout is lost).
 * @param blockSize - The block size the scan used.
 * @returns The plan.
 */
export function planRepair(zeroBlocks: number[], size: number, parts: ByteRange[] | undefined, blockSize = SCAN_BLOCK): RepairPlan {
  if (!parts?.length) return { kind: "whole" };
  const ranges = damagedRanges(zeroBlocks, size, blockSize, parts);
  const bytes = ranges.reduce((n, r) => n + r.end - r.start + 1, 0);
  if (ranges.length === 0 || bytes > size / 2) return { kind: "whole" };
  return { kind: "ranges", ranges, bytes };
}
