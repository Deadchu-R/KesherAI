import { redact } from "./fault-log.js";

/** How long the excerpt of a scheduled run's answer is in the phone notification. */
export const SCHEDULED_EXCERPT_CHARS = 120;

/**
 * A short, safe excerpt of an answer for a notification: secrets and the home folder are removed (like the fault log),
 * any other absolute file path becomes "…", markdown marks and line breaks are flattened, and the text is cut at a
 * word with "…" when it is longer than `max`.
 *
 * @param text - The final answer.
 * @param max - The most characters (default {@link SCHEDULED_EXCERPT_CHARS}).
 * @returns The excerpt ("" when there is nothing to show).
 */
export function resultExcerpt(text: string | undefined, max = SCHEDULED_EXCERPT_CHARS): string {
  let t = redact(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|~\/|\/(?:home|Users|root|etc|var|tmp|mnt|opt|usr)\/)[^\s"'`)\]]*/g, "…")
    .replace(/[#*_`>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= max) return t;
  t = t.slice(0, max - 1);
  const sp = t.lastIndexOf(" ");
  if (sp > max * 0.6) t = t.slice(0, sp);
  return `${t.trimEnd()}…`;
}
