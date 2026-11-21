/**
 * Voice mode's streaming parts (docs/RESEARCH_LOG.md, "Realtime voice hand-off"), all pure so the page
 * (apps/web/src/VoiceMode.tsx) and the tests share them:
 *
 * - {@link SttStream}: speech to text while the user talks. The utterance is cut at short pauses into segments that
 *   are transcribed as soon as they close (in the background, while the user keeps talking), and the open segment
 *   gets a quick partial transcript every ~0.7 s, shown live. When the user stops, only the last segment is left, and
 *   when the latest partial already heard all of it, nothing is transcribed again: the words are ready at once.
 * - {@link splitSentences} / {@link nextSentences}: a Hebrew and English sentence splitter that also works on text
 *   that is still being written (numbers, abbreviations, list numbers and code blocks are not cut).
 * - {@link SentenceQueue}: says sentences one after another, so the first one starts early; barge-in stops it at once.
 */

/** Tuning for {@link SttStream}, in seconds. */
export const STT_STREAM = {
  /** Time between partial transcripts of the open segment. */
  partialEvery: 0.7,
  /** Shortest open segment worth a partial transcript. */
  minPartial: 0.6,
  /** A pause this long inside speech can close a segment… */
  pauseCut: 0.35,
  /** …once the segment is at least this long (short sentences stay whole, so whisper has their context). */
  minSegment: 3,
  /** A segment is closed at this length even without a pause. */
  maxSegment: 20,
  /** Quiet kept after the last loud block when a segment is sent (the rest is silence; less to transcribe). */
  tail: 0.3,
} as const;

/** What the page must transcribe: a closed segment (kept) or a partial of the open one (shown, may be replaced). */
export interface SttAction<T> {
  do: "segment" | "partial";
  /** Pass back with the text to {@link SttStream.done}. */
  id: number;
  /** The audio blocks, in order. */
  blocks: T[];
}

/**
 * Speech to text while the user talks, over blocks of audio of a fixed length (the page's microphone blocks).
 * It only decides what to transcribe and when; the page sends the audio and passes the text back.
 *
 * @typeParam T - One block of audio (a Float32Array in the page; anything in the tests).
 */
export class SttStream<T> {
  /** Closed segments in order: their text once transcribed, and the last partial as a guess until then. */
  private parts: Array<{ id: number; text?: string; guess?: string; retry?: T[] }> = [];
  /** The open segment's blocks, and the index of its last loud one (-1: no speech yet). */
  private seg: T[] = [];
  private lastLoud = -1;
  /** How many open segments came before this one (a partial belongs to one segment). */
  private segNo = 0;
  /** The latest partial of the open segment: its id, how many blocks it heard, and its text once back. */
  private partial?: { id: number; segNo: number; covers: number; text?: string };
  /** A partial on its way (only one at a time, so the engine is never flooded). */
  private inFlight?: number;
  private since = 0;
  private nextId = 1;
  private ended = false;
  /** Partials are asked for (off once the engine says it cannot do them quickly). */
  private live = true;

  /**
   * @param block - One block's length in seconds (2048 samples at 16 kHz: 0.128).
   * @param o - Tuning (defaults: {@link STT_STREAM}).
   */
  constructor(private readonly block: number, private readonly o: { [K in keyof typeof STT_STREAM]: number } = STT_STREAM) {}

  /** Seconds of quiet at the end of the open segment. */
  private quiet(): number {
    return (this.seg.length - 1 - this.lastLoud) * this.block;
  }

  /** The open segment, cut after its last speech (plus a little quiet). */
  private trimmed(): T[] {
    return this.seg.slice(0, Math.min(this.seg.length, this.lastLoud + 1 + Math.ceil(this.o.tail / this.block - 1e-9)));
  }

  /**
   * Adds the next block of audio.
   *
   * @param block - The audio.
   * @param loud - Whether it is speech (the page's loudness detector).
   * @returns What to transcribe now (a closed segment and/or a partial), in order.
   */
  push(block: T, loud: boolean): Array<SttAction<T>> {
    if (this.ended) return [];
    const out: Array<SttAction<T>> = [];
    this.seg.push(block);
    if (loud) this.lastLoud = this.seg.length - 1;
    this.since += this.block;
    const length = this.seg.length * this.block;
    // A pause after enough words, or a very long segment: close it and transcribe it now, in the background.
    if (this.lastLoud >= 0 && ((length >= this.o.minSegment && this.quiet() >= this.o.pauseCut) || length >= this.o.maxSegment)) {
      const id = this.nextId++;
      const guess = this.partial?.segNo === this.segNo ? this.partial.text : undefined;
      this.parts.push({ id, ...(guess ? { guess } : {}) });
      out.push({ do: "segment", id, blocks: this.trimmed() });
      this.seg = [];
      this.lastLoud = -1;
      this.segNo++;
      this.partial = undefined;
      return out;
    }
    // A partial of the open segment, when the last one is back and there is new speech since it.
    const heard = this.partial?.segNo === this.segNo ? this.partial.covers : 0;
    if (this.live && this.inFlight === undefined && this.lastLoud >= 0 && heard <= this.lastLoud && this.since >= this.o.partialEvery && length >= this.o.minPartial) {
      const id = this.nextId++;
      this.inFlight = id;
      this.since = 0;
      this.partial = { id, segNo: this.segNo, covers: this.seg.length };
      out.push({ do: "partial", id, blocks: this.seg.slice() });
    }
    return out;
  }

  /**
   * The user stopped talking: what is still to be transcribed. Nothing when the latest partial already heard all the
   * speech in the open segment (its text, or the partial still on its way, becomes the last part).
   */
  end(): Array<SttAction<T>> {
    if (this.ended) return [];
    this.ended = true;
    if (this.lastLoud < 0) return [];
    const p = this.partial?.segNo === this.segNo ? this.partial : undefined;
    if (p && p.covers > this.lastLoud) {
      // Still on its way: its audio is kept, in case it fails and must be sent again.
      this.parts.push({ id: p.id, ...(p.text !== undefined ? { text: p.text } : { retry: this.trimmed() }) });
      return [];
    }
    const id = this.nextId++;
    this.parts.push({ id, ...(p?.text ? { guess: p.text } : {}) });
    return [{ do: "segment", id, blocks: this.trimmed() }];
  }

  /**
   * A transcript came back.
   *
   * @param id - The action's id.
   * @param text - What was heard, or null when it failed (a failed segment counts as no words).
   * @returns What to transcribe again: a failed partial that had become the last part is sent as a segment.
   */
  done(id: number, text: string | null): Array<SttAction<T>> {
    if (this.inFlight === id) this.inFlight = undefined;
    if (this.partial?.id === id) {
      if (text === null) this.partial = undefined;
      else this.partial.text = text.trim();
    }
    const part = this.parts.find((p) => p.id === id);
    if (!part) return [];
    if (text === null && part.retry) {
      const again = { do: "segment" as const, id: this.nextId++, blocks: part.retry };
      part.id = again.id;
      delete part.retry;
      return [again];
    }
    part.text = (text ?? "").trim();
    delete part.retry;
    return [];
  }

  /** The engine cannot give quick partials (no loaded local model): stop asking; segments still go. */
  noPartials(): void {
    this.live = false;
  }

  /** Whether the user stopped and every part has its text (then {@link text} is final). */
  ready(): boolean {
    return this.ended && this.parts.every((p) => p.text !== undefined);
  }

  /** What was heard so far: the closed segments (or their guesses) and, while talking, the open segment's partial. */
  text(): string {
    const texts = this.parts.map((p) => p.text ?? p.guess ?? "");
    if (!this.ended && this.partial?.segNo === this.segNo && this.partial.text) texts.push(this.partial.text);
    return mergeTranscripts(texts);
  }
}

/** Whisper's marks for no speech ("[BLANK_AUDIO]", "(music)", "[מוזיקה]"). */
const NOISE = /^\s*[[(][^\])]{0,40}[\])]\s*$/;

/**
 * Joins the transcripts of consecutive pieces of one utterance: empty pieces and whisper's no-speech marks are
 * dropped, and words repeated across a cut (whisper sometimes hears the boundary word in both pieces) are said once.
 *
 * @param parts - The pieces' texts, in order.
 */
export function mergeTranscripts(parts: string[]): string {
  const words: string[] = [];
  const key = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  for (const raw of parts) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text || NOISE.test(text)) continue;
    let next = text.split(" ");
    // Up to three words at the end of what we have, repeated at the start of the next piece.
    for (let k = Math.min(3, words.length, next.length); k > 0; k--) {
      const tail = words.slice(-k).map(key);
      if (tail.every((w, i) => w && w === key(next[i]!))) {
        next = next.slice(k);
        break;
      }
    }
    words.push(...next);
  }
  return words.join(" ");
}

/** Words before a period that do not end a sentence (lower case, without the period). */
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "prof", "st", "sr", "jr", "vs", "etc", "e.g", "i.e", "eg", "ie", "u.s", "u.k", "a.m", "p.m", "no", "fig", "approx", "inc", "ltd", "co", "cf", "al", "ver", "v", "min", "max", "sec", "dept", "est", "mt", "ft", "lb", "oz", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]);

/**
 * Where the text's sentences end: positions just after each end (after the punctuation and closing quotes), in order.
 * A period does not end a sentence in a number (3.14), after an abbreviation (Dr., e.g.), an initial (J. K.), a list
 * number at the start of a line (1.), or before a lower-case English word. A line break always ends one.
 * The last end is only counted when something follows it, since the text may still be growing ("3." → "3.5").
 */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  const re = /[.!?…]+["'”’)\]»*_]*(?=\s)|\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const at = m.index + m[0].length;
    if (m[0] === "\n") {
      ends.push(at);
      continue;
    }
    if (/^\.(?![.!?…])/.test(m[0])) {
      const before = text.slice(text.lastIndexOf("\n", m.index - 1) + 1, m.index);
      const word = /(\S+)$/.exec(before)?.[1] ?? "";
      const bare = word.replace(/^["'“‘([«]+/, "").toLowerCase();
      // "1." at the start of a line is a list number; "J." an initial; "Dr." an abbreviation.
      if (/^\s*\d{1,3}$/.test(before) || /^[A-Z]$/.test(bare.toUpperCase()) || ABBREVIATIONS.has(bare)) continue;
      // The next word starts in lower case (English): the same sentence goes on.
      const next = /^\s+(\S)/.exec(text.slice(at))?.[1];
      if (next && /[a-z]/.test(next)) continue;
    }
    ends.push(at);
  }
  return ends;
}

/** Text as it is said: no markdown, links or code (one sentence; see `shortSpoken` in voice-handoff.ts). */
function spokenSentence(text: string, he: boolean): string {
  return text
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, " ")
    .replace(/```[\s\S]*?(```|$)/g, he ? " (קוד על המסך) " : " (code on screen) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/gm, "")
    .replace(/[#*_>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences longer than this are said in two (at a comma), so the first words start early. */
const LONG_SENTENCE = 160;

/**
 * The next sentences of a text that is still being written (an answer as it streams), ready to be said.
 *
 * @param text - All the text so far.
 * @param from - Where the last call stopped (its `next`; 0 at first).
 * @param final - The text is complete: the rest counts as the last sentence.
 * @param he - Hebrew (the words said in place of code).
 * @returns The sentences as they should be heard (empty ones dropped), and where to go on from.
 */
export function nextSentences(text: string, from: number, final: boolean, he = false): { sentences: string[]; next: number } {
  let rest = text.slice(from);
  let cutAt = rest.length;
  // A code block or thinking that is not closed yet waits whole (it is said as "code on screen" once it closes).
  if (!final) {
    const fences = [...rest.matchAll(/```/g)];
    if (fences.length % 2 === 1) cutAt = fences.at(-1)!.index;
    const think = rest.lastIndexOf("<think>");
    if (think >= 0 && rest.indexOf("</think>", think) < 0) cutAt = Math.min(cutAt, think);
    rest = rest.slice(0, cutAt);
  }
  // Code blocks count as one sentence each: no splitting inside them.
  const blocks: Array<[number, number]> = [...rest.matchAll(/```[\s\S]*?```|<think>[\s\S]*?<\/think>/g)].map((m) => [m.index, m.index + m[0].length]);
  const inside = (i: number) => blocks.some(([a, b]) => i > a && i < b);
  let ends = sentenceEnds(rest).filter((e) => !inside(e));
  for (const [a, b] of blocks) for (const at of [a, b]) if (at > 0 && !ends.includes(at)) ends.push(at);
  ends = ends.sort((a, b) => a - b);
  if (final && (ends.at(-1) ?? 0) < rest.length) ends.push(rest.length);
  // A long first sentence with no end yet: say up to its last comma, so the voice starts early.
  if (!final && !ends.length && rest.length > LONG_SENTENCE) {
    const comma = Math.max(rest.lastIndexOf(", "), rest.lastIndexOf("; "), rest.lastIndexOf(" — "), rest.lastIndexOf("، "));
    if (comma > 80 && !inside(comma)) ends.push(comma + 1);
  }
  const sentences: string[] = [];
  let start = 0;
  for (const end of ends) {
    if (end <= start) continue;
    const said = spokenSentence(rest.slice(start, end), he);
    start = end;
    if (/[\p{L}\p{N}]/u.test(said)) sentences.push(said);
  }
  return { sentences, next: from + start };
}

/**
 * A whole text in sentences, as they should be heard (see {@link nextSentences}).
 *
 * @param text - The text.
 * @param he - Hebrew (the words said in place of code).
 */
export function splitSentences(text: string, he = false): string[] {
  return nextSentences(text, 0, true, he).sentences;
}

/** Says one sentence and calls `done` when it ends or is stopped. */
export type SpeakOne = (text: string, done: () => void) => void;

/**
 * Says texts sentence by sentence, in order. Long lines start sooner (the first sentence is synthesized alone), and
 * {@link stop} (barge-in) stops the sentence being said and drops the rest at once; a stopped sentence's late end
 * never starts the next one.
 */
export class SentenceQueue {
  private queue: string[] = [];
  private onEnd?: () => void;
  private gen = 0;
  private busy = false;

  /**
   * @param speakOne - Says one sentence (the app's voice).
   * @param stopOne - Stops the sentence being said.
   * @param he - Hebrew (for {@link splitSentences}).
   */
  constructor(private readonly speakOne: SpeakOne, private readonly stopOne: () => void, private readonly he = false) {}

  /** Whether a sentence is being said or waits. */
  get speaking(): boolean {
    return this.busy;
  }

  /**
   * Says a text (replacing anything being said), sentence by sentence.
   *
   * @param text - What to say.
   * @param onEnd - Called once, after the last sentence (not when stopped).
   */
  play(text: string, onEnd?: () => void): void {
    this.stop();
    this.queue = splitSentences(text, this.he);
    this.onEnd = onEnd;
    this.next(this.gen);
  }

  /** Stops at once: the sentence being said ends and the rest is dropped. */
  stop(): void {
    this.gen++;
    this.queue = [];
    this.onEnd = undefined;
    if (this.busy) {
      this.busy = false;
      this.stopOne();
    }
  }

  private next(gen: number): void {
    if (gen !== this.gen) return;
    const text = this.queue.shift();
    if (text === undefined) {
      this.busy = false;
      const end = this.onEnd;
      this.onEnd = undefined;
      end?.();
      return;
    }
    this.busy = true;
    this.speakOne(text, () => this.next(gen));
  }
}
