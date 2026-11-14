/**
 * When dictation stops by itself: after the person has spoken, a pause of about two seconds (as AnythingLLM's quick
 * dictation, which sends after a pause). Before any speech it keeps listening (up to the bar's own limit).
 */

/** Loud enough to be speech (a frame's peak, 0–1). */
export const SPEECH_PEAK = 0.05;
/** Quiet enough to be a pause. */
export const QUIET_PEAK = 0.02;

/** A running count of speech and quiet, frame by frame. */
export interface SilenceState {
  spoke: number;
  quietMs: number;
}

/**
 * Takes one frame's loudness.
 *
 * @param s - The state so far.
 * @param peak - The frame's peak (0–1).
 * @param frameMs - How long a frame is.
 * @param pauseMs - The pause that ends dictation (default 2 s).
 * @returns The new state, and whether to stop now.
 */
export function hearFrame(s: SilenceState, peak: number, frameMs: number, pauseMs = 2000): { state: SilenceState; stop: boolean } {
  const spoke = peak >= SPEECH_PEAK ? s.spoke + 1 : s.spoke;
  const quietMs = peak < QUIET_PEAK ? s.quietMs + frameMs : 0;
  // Two loud frames (~half a second) count as speech, so a click or a cough alone does not.
  return { state: { spoke, quietMs }, stop: spoke >= 2 && quietMs >= pauseMs };
}
