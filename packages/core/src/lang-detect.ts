/**
 * Automatic spoken-language detection for every speech-to-text path.
 *
 * whisper tells, for a short window of speech, how likely each of its ~100 languages is. Taking whisper's single
 * best guess over a whole recording went wrong in practice (Hebrew was taken for Spanish), so instead:
 *   1. a few short windows are sampled (start, middle, end);
 *   2. the vote is restricted to "my languages" (Settings → Speech); a language outside them wins only with very
 *      high confidence (someone really speaking Spanish), otherwise it is ignored;
 *   3. after transcribing, the text is checked against the language's script, and a garbled result is transcribed
 *      again with the next likely language;
 *   4. long recordings are cut into parts, each detected on its own (a recording that switches language).
 *
 * Everything here is pure (no engine), so it is tested with a fake whisper.
 */

/** Language code (he, en, …) → probability 0..1. */
export type LangProbs = Record<string, number>;

/** Whisper's English language names (as the server reports them) → ISO codes, for the languages people pick. */
const NAME_TO_CODE: Record<string, string> = {
  hebrew: "he", english: "en", arabic: "ar", russian: "ru", spanish: "es", french: "fr", german: "de", italian: "it", portuguese: "pt",
  ukrainian: "uk", turkish: "tr", persian: "fa", amharic: "am", polish: "pl", dutch: "nl", greek: "el", hindi: "hi", chinese: "zh", japanese: "ja", korean: "ko", yiddish: "yi",
};

/** The languages offered in Settings → Speech → My languages (code, own name in Hebrew and English). */
export const SPEECH_LANGUAGES: Array<{ code: string; he: string; en: string; own: string }> = [
  { code: "he", he: "עברית", en: "Hebrew", own: "עברית" },
  { code: "en", he: "אנגלית", en: "English", own: "English" },
  { code: "ar", he: "ערבית", en: "Arabic", own: "العربية" },
  { code: "ru", he: "רוסית", en: "Russian", own: "Русский" },
  { code: "es", he: "ספרדית", en: "Spanish", own: "Español" },
  { code: "fr", he: "צרפתית", en: "French", own: "Français" },
  { code: "de", he: "גרמנית", en: "German", own: "Deutsch" },
  { code: "am", he: "אמהרית", en: "Amharic", own: "አማርኛ" },
  { code: "uk", he: "אוקראינית", en: "Ukrainian", own: "Українська" },
];

/**
 * Turns whisper's probabilities (keyed by code or by English name) into codes.
 *
 * @param raw - e.g. `{ hebrew: 0.9, english: 0.05 }` or `{ he: 0.9 }`.
 * @returns The same with ISO codes; unknown names are dropped; values outside 0..1 are clamped.
 */
export function normalizeProbs(raw: Record<string, unknown> | undefined): LangProbs {
  const out: LangProbs = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const key = k.toLowerCase();
    const code = /^[a-z]{2,3}$/.test(key) ? key : NAME_TO_CODE[key];
    const n = Number(v);
    if (code && Number.isFinite(n)) out[code] = Math.min(1, Math.max(0, n));
  }
  return out;
}

/**
 * "My languages" with the default filled in: the app's language plus English.
 *
 * @param set - The saved list (empty or missing: not chosen yet).
 * @param appLocale - The app's language (`he` or `en`).
 * @returns Two-letter codes, no repeats, at least one.
 */
export function myLanguages(set: unknown, appLocale = "he"): string[] {
  const list = Array.isArray(set) ? set.filter((x): x is string => typeof x === "string" && /^[a-z]{2,3}$/.test(x)) : [];
  const out = [...new Set(list)];
  return out.length ? out : [...new Set([appLocale === "en" ? "en" : "he", "en"])];
}

/** What the vote decided. */
export interface Vote {
  /** The language to transcribe in. */
  lang: string;
  /** Its average probability over the windows (0 when nothing could be told). */
  confidence: number;
  /** A language outside "my languages" won with very high confidence. */
  outside: boolean;
  /** All candidates, most likely first: mine by score, a winning outside language first. Used for "next likely". */
  ranked: string[];
}

/** Thresholds of the vote. */
export const VOTE = {
  /** A language outside "my languages" wins only at this average probability or more. */
  outsideMin: 0.9,
  /** Below this average probability a language of mine is not trusted (then the first of mine is used). */
  mineMin: 0.15,
};

/**
 * Votes over the windows' probabilities, restricted to "my languages".
 *
 * @param windows - One probability map per sampled window (windows whose detection failed are left out).
 * @param mine - "My languages", most important first (the first is the tie-break and the fallback).
 * @returns The vote, or undefined when there is nothing to vote on (no windows): the caller falls back.
 */
export function voteLanguage(windows: LangProbs[], mine: string[]): Vote | undefined {
  if (!windows.length || !mine.length) return undefined;
  const avg = (l: string) => windows.reduce((a, w) => a + (w[l] ?? 0), 0) / windows.length;
  const mineScored = mine.map((l, i) => ({ l, p: avg(l), i })).sort((a, b) => b.p - a.p || a.i - b.i);
  const others = [...new Set(windows.flatMap((w) => Object.keys(w)))].filter((l) => !mine.includes(l)).map((l) => ({ l, p: avg(l) })).sort((a, b) => b.p - a.p);
  const best = mineScored[0]!;
  const out = others[0];
  // Someone really speaking another language: very sure, and clearly ahead of mine.
  if (out && out.p >= VOTE.outsideMin && out.p > best.p) {
    return { lang: out.l, confidence: out.p, outside: true, ranked: [out.l, ...mineScored.map((m) => m.l)] };
  }
  // Nothing of mine is likely, and no other language is sure either (silence, music): the first of mine.
  if (best.p < VOTE.mineMin) return { lang: mine[0]!, confidence: best.p, outside: false, ranked: mine };
  return { lang: best.l, confidence: best.p, outside: false, ranked: mineScored.map((m) => m.l) };
}

/** Writing systems told apart by the checks below. */
export type Script = "hebrew" | "latin" | "arabic" | "cyrillic" | "other";

const SCRIPT_OF_LANG: Record<string, Script> = { he: "hebrew", yi: "hebrew", ar: "arabic", fa: "arabic", ru: "cyrillic", uk: "cyrillic", am: "other" };

/** The script a language is written in (Latin for the rest). */
export function scriptOfLang(lang: string): Script {
  return SCRIPT_OF_LANG[lang] ?? (/^(zh|ja|ko|hi|el|am)$/.test(lang) ? "other" : "latin");
}

/**
 * Counts letters per script in a text.
 *
 * @param text - Any text.
 * @returns The letter counts.
 */
export function scriptCounts(text: string): Record<Script, number> {
  const c: Record<Script, number> = { hebrew: 0, latin: 0, arabic: 0, cyrillic: 0, other: 0 };
  for (const ch of text) {
    const n = ch.codePointAt(0)!;
    if (n >= 0x590 && n <= 0x5ff) c.hebrew++;
    else if ((n >= 0x41 && n <= 0x5a) || (n >= 0x61 && n <= 0x7a) || (n >= 0xc0 && n <= 0x24f)) c.latin++;
    else if ((n >= 0x600 && n <= 0x6ff) || (n >= 0x750 && n <= 0x77f)) c.arabic++;
    else if (n >= 0x400 && n <= 0x4ff) c.cyrillic++;
    else if (/\p{L}/u.test(ch)) c.other++;
  }
  return c;
}

/**
 * Whether a transcript's script fits the language it was transcribed as. Code-switching is normal (Hebrew with
 * English words), so a Hebrew result passes with as little as a fifth of its letters Hebrew; a Latin-script
 * language needs mostly Latin letters.
 *
 * @param text - The transcript.
 * @param lang - The language it was transcribed as.
 * @returns False when the text is mostly in another script (Latin text for Hebrew, Hebrew letters for English).
 */
export function scriptMatches(text: string, lang: string): boolean {
  const c = scriptCounts(text);
  const total = c.hebrew + c.latin + c.arabic + c.cyrillic + c.other;
  if (total < 8) return true; // too little to judge
  const want = scriptOfLang(lang);
  if (want === "other") return true;
  const share = c[want] / total;
  return want === "latin" ? share >= 0.6 : share >= 0.2;
}

/**
 * Whether a transcript looks like garbage: whisper's well-known failures are one phrase looping, or a few
 * characters repeated over and over.
 *
 * @param text - The transcript.
 * @returns True for a loop or a repeated character run.
 */
export function looksLikeGarbage(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 30) return false;
  if (/(.)\1{14,}/u.test(t)) return true;
  const words = t.split(" ");
  if (words.length >= 12 && new Set(words.map((w) => w.toLowerCase())).size / words.length < 0.2) return true;
  // The same 4-word phrase four times or more.
  const grams = new Map<string, number>();
  for (let i = 0; i + 4 <= words.length; i++) {
    const g = words.slice(i, i + 4).join(" ").toLowerCase();
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  // Real speech repeats itself too ("הזה הזה הזה", "ככה וככה וככה"): only a loop that covers much of the text counts.
  return [...grams.values()].some((n) => n >= 4 && n * 4 >= words.length * 0.4);
}

/** A 16-bit PCM WAV's layout. */
interface WavInfo { rate: number; channels: number; dataStart: number; dataBytes: number }

/** Reads a PCM 16-bit WAV's header (undefined for anything else). */
export function wavInfo(wav: Buffer): WavInfo | undefined {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return undefined;
  let pos = 12;
  let fmt: { rate: number; channels: number } | undefined;
  while (pos + 8 <= wav.length) {
    const id = wav.toString("ascii", pos, pos + 4);
    const size = wav.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      if (wav.readUInt16LE(pos + 8) !== 1 || wav.readUInt16LE(pos + 22) !== 16) return undefined;
      fmt = { channels: wav.readUInt16LE(pos + 10), rate: wav.readUInt32LE(pos + 12) };
    } else if (id === "data") {
      if (!fmt || !fmt.channels || !fmt.rate) return undefined;
      return { ...fmt, dataStart: pos + 8, dataBytes: Math.min(size, wav.length - pos - 8) };
    }
    pos += 8 + size + (size & 1);
  }
  return undefined;
}

/** How long a WAV is, in seconds (0 when it is not a 16-bit PCM WAV). */
export function wavSeconds(wav: Buffer): number {
  const i = wavInfo(wav);
  return i ? i.dataBytes / (i.rate * i.channels * 2) : 0;
}

/**
 * A piece of a WAV as its own WAV.
 *
 * @param wav - 16-bit PCM WAV.
 * @param from - Start, in seconds.
 * @param length - Length, in seconds.
 * @returns The piece, or undefined when the input is not a 16-bit PCM WAV.
 */
export function sliceWav(wav: Buffer, from: number, length: number): Buffer | undefined {
  const i = wavInfo(wav);
  if (!i) return undefined;
  const frame = i.channels * 2;
  const a = Math.min(i.dataBytes, Math.floor(Math.max(0, from) * i.rate) * frame);
  const b = Math.min(i.dataBytes, a + Math.floor(length * i.rate) * frame);
  const data = wav.subarray(i.dataStart + a, i.dataStart + b);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(i.channels, 22);
  head.writeUInt32LE(i.rate, 24);
  head.writeUInt32LE(i.rate * frame, 28);
  head.writeUInt16LE(frame, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/**
 * Where to sample: the start, middle and end of a recording (one window when it is short).
 *
 * @param seconds - The recording's length.
 * @param len - A window's length (whisper reads at most 30 s to detect).
 * @returns Window starts, in seconds.
 */
export function windowStarts(seconds: number, len = 25): number[] {
  if (seconds <= len * 1.6) return [0];
  if (seconds <= len * 3) return [0, Math.max(0, seconds - len)];
  return [0, (seconds - len) / 2, seconds - len];
}

/** Longest part detected and transcribed as one (seconds): a longer recording is cut so a language switch shows. */
export const PART_SECONDS = 300;

/** What one detected piece came out as. */
export interface DetectedPart {
  /** Where the part starts, in seconds. */
  from: number;
  lang: string;
  confidence: number;
  /** A language outside "my languages" won. */
  outside: boolean;
  /** Re-run with the next likely language because the text did not fit. */
  retried?: boolean;
  /** The languages to offer for "transcribe again as …", most likely first. */
  ranked: string[];
}

/** What the engine side has to provide (a fake in tests). */
export interface DetectEngine {
  /** Language probabilities of a short WAV; undefined when this engine cannot tell. */
  detect: (wav: Buffer) => Promise<LangProbs | undefined>;
  /** Text of a WAV in a language. */
  transcribe: (wav: Buffer, lang: string) => Promise<string>;
}

/**
 * Detects the language of one WAV by sampling windows, then votes.
 *
 * @param e - The engine.
 * @param wav - A 16-bit PCM WAV.
 * @param mine - "My languages".
 * @returns The vote, or undefined when detection is not available.
 */
export async function detectWav(e: DetectEngine, wav: Buffer, mine: string[]): Promise<Vote | undefined> {
  const secs = wavSeconds(wav);
  const starts = secs > 0 ? windowStarts(secs) : [0];
  const probs: LangProbs[] = [];
  for (const s of starts) {
    const piece = secs > 0 ? sliceWav(wav, s, 25) : wav;
    if (!piece) continue;
    const p = await e.detect(piece).catch(() => undefined);
    if (p && Object.keys(p).length) probs.push(p);
  }
  return voteLanguage(probs, mine);
}

/**
 * Transcribes one WAV in its detected language, and again with the next likely language of mine when the text's
 * script does not fit or it looks like garbage (one retry per remaining language, at most two).
 *
 * @param e - The engine.
 * @param wav - A 16-bit PCM WAV.
 * @param mine - "My languages".
 * @param from - Where this part starts in the whole recording (for the report).
 * @returns The text and what was detected, or undefined when detection is not available.
 */
export async function transcribeDetected(e: DetectEngine, wav: Buffer, mine: string[], from = 0): Promise<{ text: string; part: DetectedPart } | undefined> {
  const vote = await detectWav(e, wav, mine);
  if (!vote) return undefined;
  const tried: string[] = [];
  let lang = vote.lang;
  let text = "";
  for (let n = 0; n < 3; n++) {
    tried.push(lang);
    text = await e.transcribe(wav, lang);
    if (!text.trim() || (scriptMatches(text, lang) && !looksLikeGarbage(text))) break;
    const next = vote.ranked.find((l) => !tried.includes(l) && mine.includes(l));
    if (!next) break;
    lang = next;
  }
  const first = tried[0]!;
  return { text, part: { from, lang, confidence: lang === first ? vote.confidence : 0, outside: vote.outside && lang === first, ...(lang !== first ? { retried: true } : {}), ranked: vote.ranked } };
}

/**
 * Moves the [m:ss] marks of a timed transcript later by some seconds (a part of a longer recording).
 *
 * @param text - Lines like `[0:01] hello`.
 * @param by - Seconds to add.
 */
export function shiftStamps(text: string, by: number): string {
  if (!by) return text;
  return text.replace(/^\[(\d+):(\d{2})\]/gm, (_m, m: string, s: string) => {
    const t = Number(m) * 60 + Number(s) + Math.round(by);
    return `[${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}]`;
  });
}

/**
 * Detects and transcribes a whole recording part by part (each part up to {@link PART_SECONDS}), so a recording that
 * changes language half way is handled.
 *
 * @param e - The engine.
 * @param wav - A 16-bit PCM WAV.
 * @param mine - "My languages".
 * @param timed - The engine's text has [m:ss] marks to shift per part.
 * @returns The joined text and one entry per part; undefined when not a PCM WAV or detection is not available.
 */
export async function transcribeInParts(e: DetectEngine, wav: Buffer, mine: string[], timed = false): Promise<{ text: string; parts: DetectedPart[] } | undefined> {
  const secs = wavSeconds(wav);
  if (secs <= 0) return undefined;
  const count = Math.max(1, Math.ceil(secs / PART_SECONDS));
  const texts: string[] = [];
  const parts: DetectedPart[] = [];
  for (let i = 0; i < count; i++) {
    const from = i * PART_SECONDS;
    const piece = count === 1 ? wav : sliceWav(wav, from, PART_SECONDS);
    if (!piece) return undefined;
    const r = await transcribeDetected(e, piece, mine, from);
    if (!r) return undefined;
    texts.push(timed ? shiftStamps(r.text, from) : r.text);
    parts.push(r.part);
  }
  return { text: texts.filter((t) => t.trim()).join(timed ? "\n" : " "), parts };
}

/**
 * Summarises the parts for the screen: the language of the longest run, and whether it changed.
 *
 * @param parts - What {@link transcribeInParts} returned.
 * @returns The main language, all languages heard (in order), and whether one was outside "my languages".
 */
export function summarizeParts(parts: DetectedPart[]): { lang: string; langs: string[]; outside: boolean; ranked: string[]; retried: boolean } {
  const langs = [...new Set(parts.map((p) => p.lang))];
  const count = new Map<string, number>();
  for (const p of parts) count.set(p.lang, (count.get(p.lang) ?? 0) + 1);
  const lang = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  return { lang, langs, outside: parts.some((p) => p.outside), ranked: parts[0]?.ranked ?? [], retried: parts.some((p) => p.retried) };
}
