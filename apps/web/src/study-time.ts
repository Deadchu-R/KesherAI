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

