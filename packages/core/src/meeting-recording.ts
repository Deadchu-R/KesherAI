import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { wavSamples } from "./meeting-speakers.js";

/**
 * Keeping a meeting's recording (an option, off by default), so its
 * transcript can follow playback. Each recorded piece (the microphone and
 * the call's sound, about half a minute each) is kept as it arrives; when
 * the meeting is written up they are laid on one timeline by the time they
 * started, mixed where they overlap, and saved as one WAV.
 */

const RATE = 16_000;

/** The meeting's recording folder. */
export function recordingDir(journalDir: string, id: string): string {
  return join(journalDir, "recordings", id.replace(/[^\w-]/g, ""));
}

/**
 * Keeps one recorded piece.
 *
 * @param dir - The meeting's recording folder.
 * @param t - When the piece started (ms).
 * @param who - `me`, `others`, or the one microphone.
 * @param wav - The piece (16 kHz mono WAV, as the recorder sends it).
 */
export async function keepRecordingPiece(dir: string, t: number, who: string | undefined, wav: Buffer): Promise<void> {
  await mkdir(join(dir, "pieces"), { recursive: true });
  await writeFile(join(dir, "pieces", `${Math.round(t)}-${who ?? "mic"}.wav`), wav);
}

/** A 16-bit mono WAV of the samples. */
export function encodeWav(samples: Float32Array, rate = RATE): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/**
 * Lays the kept pieces on one timeline and saves `recording.wav`.
 *
 * @param dir - The meeting's recording folder.
 * @returns When the recording starts (ms) and how long it is, or undefined when nothing was kept.
 */
export async function buildRecording(dir: string): Promise<{ start: number; seconds: number } | undefined> {
  const names = (await readdir(join(dir, "pieces")).catch(() => [] as string[])).filter((n) => /^\d+-\w+\.wav$/.test(n));
  if (!names.length) return undefined;
  const pieces = await Promise.all(names.map(async (n) => ({ t: Number.parseInt(n), samples: wavSamples(await readFile(join(dir, "pieces", n))) })));
  const start = Math.min(...pieces.map((p) => p.t));
  const end = Math.max(...pieces.map((p) => Math.round(((p.t - start) / 1000) * RATE) + p.samples.length));
  const all = new Float32Array(end);
  for (const p of pieces) {
    const at = Math.round(((p.t - start) / 1000) * RATE);
    for (let i = 0; i < p.samples.length; i++) all[at + i]! += p.samples[i]!;
  }
  await writeFile(join(dir, "recording.wav"), encodeWav(all));
  await rm(join(dir, "pieces"), { recursive: true, force: true });
  return { start, seconds: end / RATE };
}

/**
 * Serves the recording, with Range requests (so a player can jump in it).
 *
 * @param dir - The meeting's recording folder.
 * @param range - The request's Range header.
 * @returns Status, headers and a stream, or undefined when there is none.
 */
export async function recordingResponse(dir: string, range?: string): Promise<{ status: number; headers: Record<string, string>; body: NodeJS.ReadableStream } | undefined> {
  const file = join(dir, "recording.wav");
  const st = await stat(file).catch(() => undefined);
  if (!st) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? "");
  if (m && (m[1] || m[2])) {
    const a = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    const b = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    return { status: 206, headers: { "content-type": "audio/wav", "accept-ranges": "bytes", "content-length": String(b - a + 1), "content-range": `bytes ${a}-${b}/${st.size}` }, body: createReadStream(file, { start: a, end: b }) };
  }
  return { status: 200, headers: { "content-type": "audio/wav", "accept-ranges": "bytes", "content-length": String(st.size) }, body: createReadStream(file) };
}
