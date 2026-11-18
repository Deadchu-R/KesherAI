/** Text helpers for the relationship report page (kept apart so they are tested without the page). */

/**
 * An imported report's original text in sections: a short line with no end mark, before a longer one, is a heading
 * (What Brandon Thinks' chapter titles); the rest are its paragraphs.
 *
 * @param text - The original text.
 * @returns Its sections.
 */
export function originalSections(text: string): Array<{ title: string; body: string; quotes: Array<{ who: string; at: string; text: string }> }> {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const out: Array<{ title: string; body: string; quotes: Array<{ who: string; at: string; text: string }> }> = [];
  lines.forEach((line, i) => {
    const heading = line.length <= 70 && !/[.!?,:;"״”)]$/.test(line) && (lines[i + 1]?.length ?? 0) > 80;
    if (heading || !out.length) out.push({ title: heading ? line : "", body: heading ? "" : line, quotes: [] });
    else out[out.length - 1]!.body += `${out[out.length - 1]!.body ? "\n\n" : ""}${line}`;
  });
  return out.filter((x) => x.body);
}

