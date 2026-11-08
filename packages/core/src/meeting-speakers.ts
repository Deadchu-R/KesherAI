import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MeetingSegment } from "./journal.js";
import type { SpeakerTurn, Speakers } from "./speakers.js";

/** 16-bit PCM WAV (as the recorder sends it) to samples in [-1, 1]. */
export function wavSamples(wav: Buffer): Float32Array {
  let off = 12;
  let data: Buffer | undefined;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "data") {
      data = wav.subarray(off + 8, Math.min(wav.length, off + 8 + size));
      break;
    }
    off += 8 + size + (size % 2);
  }
  data ??= wav.subarray(44);
  const out = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

/** A recorded piece of the call, placed in the joined recording. */
export interface CallPiece {
  /** When the piece started (ms), the same as its segment's `t`. */
  t: number;
  /** Where it starts in the joined recording (seconds). */
  offset: number;
  /** Its length (seconds). */
  duration: number;
}

/**
 * Gives each piece of the call's transcript a speaker: every whisper piece
 * goes to the speaker who talked most during it, and neighbouring pieces of
 * one speaker are joined. Speakers are numbered from 1 in the order they
 * first speak. With only one speaker found, nothing is numbered.
 *
 * @param segments - The call's segments (with whisper's `parts` when the local engine wrote them).
 * @param pieces - Where each segment's audio sits in the joined recording.
 * @param turns - Who spoke when, in the joined recording.
 * @returns The new segments.
 */
export function assignSpeakers(segments: MeetingSegment[], pieces: CallPiece[], turns: SpeakerTurn[]): MeetingSegment[] {
  const order = new Map<number, number>();
  const label = (raw: number) => {
    if (!order.has(raw)) order.set(raw, order.size + 1);
    return order.get(raw)!;
  };
  const who = (a: number, b: number) => {
    let best = -1;
    let most = 0;
    const by = new Map<number, number>();
    for (const t of turns) {
      const o = Math.min(b, t.end) - Math.max(a, t.start);
      if (o <= 0) continue;
      const sum = (by.get(t.speaker) ?? 0) + o;
      by.set(t.speaker, sum);
      if (sum > most) [most, best] = [sum, t.speaker];
    }
    if (best >= 0) return best;
    // Nobody in the turns at this moment: the nearest turn.
    const mid = (a + b) / 2;
    return turns.reduce((n, t) => (Math.abs((t.start + t.end) / 2 - mid) < Math.abs((n.start + n.end) / 2 - mid) ? t : n), turns[0]!).speaker;
  };
  const out: MeetingSegment[] = [];
  for (const seg of [...segments].sort((a, b) => a.t - b.t)) {
    const piece = pieces.find((p) => p.t === seg.t);
    if (!piece || !turns.length) {
      out.push({ t: seg.t, text: seg.text, who: "others" });
      continue;
    }
    const parts = seg.parts?.length ? seg.parts : [{ start: 0, end: piece.duration, text: seg.text }];
    for (const part of parts) {
      const speaker = label(who(piece.offset + part.start, piece.offset + Math.max(part.end, part.start + 0.2)));
      const last = out[out.length - 1];
      if (last && last.speaker === speaker && seg.t + part.start * 1000 - last.t < 60_000) last.text = `${last.text} ${part.text}`;
      else out.push({ t: Math.round(seg.t + part.start * 1000), text: part.text, who: "others", speaker });
    }
  }
  if (order.size <= 1) for (const s of out) delete s.speaker;
  return out;
}

/**
 * Keeps a piece of the call's audio until the meeting is written up.
 *
 * @param dir - The meeting's audio folder.
 * @param t - When the piece started (ms).
 * @param wav - The piece.
 */
export async function keepCallPiece(dir: string, t: number, wav: Buffer): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${Math.round(t)}.wav`), wav);
}

/**
 * Tells the call's speakers apart from the kept audio, then deletes it.
 *
 * @param speakers - The speaker engine.
 * @param dir - The meeting's audio folder.
 * @param segments - The call's segments.
 * @param signal - Abort to stop.
 * @returns The new segments, or undefined when there was no audio.
 */
export async function separateSpeakers(speakers: Speakers, dir: string, segments: MeetingSegment[], signal?: AbortSignal): Promise<MeetingSegment[] | undefined> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /^\d+\.wav$/.test(f)).sort((a, b) => Number.parseInt(a) - Number.parseInt(b));
  if (!files.length) return undefined;
  try {
    const pieces: CallPiece[] = [];
    const chunks: Float32Array[] = [];
    let offset = 0;
    for (const f of files) {
      const samples = wavSamples(await readFile(join(dir, f)));
      pieces.push({ t: Number.parseInt(f), offset, duration: samples.length / 16000 });
      chunks.push(samples);
      offset += samples.length / 16000;
    }
    const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    const turns = await speakers.diarize(all, signal);
    return assignSpeakers(segments, pieces, turns);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
