/**
 * Chat-specific bidirectional text helpers. Wraps runs of Latin text inside
 * Hebrew lines (and Hebrew inside English) in `<bdi>` so punctuation and
 * numbers stay in place. Code spans, code blocks and math are always LTR.
 */

/** One piece of a text: a plain part, or a left-to-right run to isolate. */
export interface BidiRun {
  text: string;
  iso: boolean;
}

/** True when the text has a Hebrew (or Arabic) letter. */
const HAS_RTL = /[֐-׿؀-ۿ]/;

/** Latin letters and common Western diacritics. */
const IS_LATIN = /[A-Za-zÀ-ɏ]/;

/**
 * Splits a single line into runs, marking Latin runs that need isolation
 * inside an RTL context (or RTL runs inside LTR). Code spans (`...`) and
 * inline math ($...$) are never split — they stay as one LTR run.
 *
 * @param line - A single line of markdown text (no newlines).
 * @returns Array of runs; `iso: true` means wrap in `<bdi dir="ltr">`.
 */
export function isolateRuns(line: string): BidiRun[] {
  if (!line) return [];

  // Protect code spans and inline math from splitting
  const protectedSegments: { start: number; end: number }[] = [];
  const codeSpanRe = /`[^`]*`/g;
  const inlineMathRe = /\$[^$\n]+\$/g;
  let m: RegExpExecArray | null;
  while ((m = codeSpanRe.exec(line))) {
    protectedSegments.push({ start: m.index, end: m.index + m[0].length });
  }
  while ((m = inlineMathRe.exec(line))) {
    protectedSegments.push({ start: m.index, end: m.index + m[0].length });
  }

  const isProtected = (i: number): boolean =>
    protectedSegments.some((s) => i >= s.start && i < s.end);

  const lineIsRtl = HAS_RTL.test(line);
  const runs: BidiRun[] = [];
  let cur = "";
  let curIso = false;

  const flush = () => {
    if (cur) {
      runs.push({ text: cur, iso: curIso });
      cur = "";
    }
  };

  for (let i = 0; i < line.length; i++) {
    if (isProtected(i)) {
      // Accumulate protected content as-is (LTR, not isolated)
      if (curIso || !cur) {
        flush();
        curIso = false;
      }
      cur += line[i];
      continue;
    }

    const ch = line[i];
    if (!ch) continue;
    const latin = IS_LATIN.test(ch);
    const rtl = HAS_RTL.test(ch);

    // Decide if this character should be isolated
    const shouldIso = lineIsRtl ? latin : rtl;

    if (shouldIso !== curIso && cur) {
      flush();
    }
    curIso = shouldIso;
    cur += ch;
  }
  flush();

  return runs;
}

/**
 * Returns the base direction of a raw markdown string by its first strong
 * letter, ignoring code spans, links and URLs. Use this to set `dir` on the
 * container of one paragraph, list item, quote or cell.
 *
 * @param raw - Raw markdown text.
 * @returns "rtl" or "ltr" for the first strong letter, "auto" when none.
 */
export function textDir(raw: string): "ltr" | "rtl" | "auto" {
  const plain = raw
    .replace(/`[^`]*`/g, "")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, "");
  const m = /[A-Za-zÀ-ɏ֐-׿؀-ۿ]/.exec(plain);
  if (!m) return "auto";
  return /[֐-׿؀-ۿ]/.test(m[0]) ? "rtl" : "ltr";
}