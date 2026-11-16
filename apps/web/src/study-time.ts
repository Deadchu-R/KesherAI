/** `[mm:ss]` (or `[h:mm:ss]`) for a time in the recording. */
/**
 * @param sec - Seconds into the recording.
 * @returns The mark.
 */
export function stamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `[${h}:${String(m).padStart(2, "0")}:${ss}]` : `[${String(m).padStart(2, "0")}:${ss}]`;
}


/**
 * The seconds a `[mm:ss]` or `[h:mm:ss]` line starts at (0 when it has no mark), to put lines back in time order.
 *
 * @param line - A transcript line.
 * @returns The seconds.
 */
export function stampSeconds(line: string): number {
  const m = /^\[(?:(\d+):)?(\d+):(\d\d)\]/.exec(line);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}
