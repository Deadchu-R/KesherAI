import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { probeText } from "./video-cut.js";

/**
 * Media prep: what the phone editor needs from a big video or sound that lives on the PC. The phone never gets the
 * original; the PC makes once per file (cached by a hash of the file plus its modified time) a small proxy to play, a
 * sprite of thumbnails to draw the timeline, and the sound's min/max peaks to draw the waveform.
 */

/** Peaks: PCM is read at this rate (mono) and one min/max pair is made of this many samples (about 32 ms). */
export const PEAK_RATE = 8000;
export const PEAKS_PER_COLUMN = 256;
/** The thumbnails: this many per row, each this size; one per second, or fewer for very long files (see {@link spriteLayout}). */
export const SPRITE_COLS = 20;
export const SPRITE_W = 160;
export const SPRITE_H = 90;
/** At most this many thumbnails in the one sprite (a 50-minute file at one per second). */
const SPRITE_MAX = 3000;

/** Where a file is in the prep. */
export type PrepStep = "proxy" | "sprite" | "peaks";

/** What is kept about a prepared file, and what the status route answers. */
export interface PrepStatus {
  id: string;
  state: "queued" | "running" | "done" | "error";
  step?: PrepStep;
  error?: string;
  /** "video" has a picture; "audio" has only sound (no sprite). */
  kind?: "video" | "audio";
  duration?: number;
  /** Which of the parts can be fetched now. */
  ready: { proxy: boolean; sprite: boolean; peaks: boolean };
  /** The sprite's index: the picture is `cols` thumbnails wide, one every `every` seconds. */
  sprite?: { cols: number; rows: number; w: number; h: number; every: number; count: number };
  /** The peaks' layout: unsigned 8-bit min,max pairs, one pair per `perColumn` samples at `rate` Hz. */
  peaks?: { rate: number; perColumn: number; columns: number };
}

/** The key of a file: a hash of its size, modified time, first and last megabyte (not all of a multi-gigabyte file). */
export async function mediaKey(file: string): Promise<string> {
  const st = await stat(file);
  const h = createHash("sha1").update(`${st.size}:${Math.floor(st.mtimeMs)}:`);
  const fh = await open(file, "r");
  try {
    const n = Math.min(st.size, 1 << 20);
    const buf = Buffer.alloc(n);
    for (const at of [0, Math.max(0, st.size - n)]) {
      const { bytesRead } = await fh.read(buf, 0, n, at);
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return h.digest("hex");
}

/** A prep id is a key: 40 hex characters, nothing else, so it can never name a path. */
export const isPrepId = (id: string): boolean => /^[a-f0-9]{40}$/.test(id);

/** The length in seconds from `ffmpeg -i`'s report (0 when not found). */
export function durationOf(text: string): number {
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/** The proxy: 480p (or smaller) H.264 with a key frame about every half second so a seek is quick, AAC 96 k. */
export function proxyArgs(input: string, output: string, fps: number): string[] {
  const g = String(Math.max(1, Math.round((fps || 30) * 0.5)));
  return ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vf", "scale=-2:min(480\\,ih),format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-profile:v", "main", "-g", g, "-keyint_min", g, "-sc_threshold", "0", "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", output];
}

/** A sound's proxy: AAC only. */
export const audioProxyArgs = (input: string, output: string): string[] => ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", output];

/** How the sprite is laid out for a length: one thumbnail per second, or one per `every` seconds beyond 50 minutes. */
export function spriteLayout(duration: number): { cols: number; rows: number; w: number; h: number; every: number; count: number } {
  const every = Math.max(1, Math.ceil(duration / SPRITE_MAX));
  const count = Math.max(1, Math.ceil(duration / every));
  return { cols: SPRITE_COLS, rows: Math.ceil(count / SPRITE_COLS), w: SPRITE_W, h: SPRITE_H, every, count };
}

/** The sprite: one JPEG with the thumbnails in rows, left to right. */
export function spriteArgs(input: string, output: string, l: ReturnType<typeof spriteLayout>): string[] {
  return ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-an", "-vf", `fps=1/${l.every},scale=${l.w}:${l.h}:force_original_aspect_ratio=decrease,pad=${l.w}:${l.h}:(ow-iw)/2:(oh-ih)/2,tile=${l.cols}x${l.rows}`, "-frames:v", "1", "-q:v", "6", output];
}

/** The sound as raw 16-bit little-endian mono PCM on stdout, for {@link PeaksBuilder}. */
export const pcmArgs = (input: string): string[] => ["-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", String(PEAK_RATE), "-f", "s16le", "-"];

/**
 * Makes min/max peaks from PCM that arrives in pieces (any size, even half a sample). Each column is the lowest and
 * highest sample of `perColumn` samples, squeezed to 8 bits (128 is silence).
 */
export class PeaksBuilder {
  private out: number[] = [];
  private carry: number | undefined;
  private n = 0;
  private lo = 32767;
  private hi = -32768;
  /** @param perColumn - Samples per column. */
  constructor(private readonly perColumn = PEAKS_PER_COLUMN) {}

  /** Adds the next piece of PCM. */
  push(chunk: Uint8Array): void {
    let i = 0;
    if (this.carry !== undefined && chunk.length) {
      this.add(((chunk[0]! << 8) | this.carry) << 16 >> 16);
      this.carry = undefined;
      i = 1;
    }
    for (; i + 1 < chunk.length; i += 2) this.add((((chunk[i + 1]! << 8) | chunk[i]!) << 16) >> 16);
    if (i < chunk.length) this.carry = chunk[i];
  }

  private add(v: number): void {
    if (v < this.lo) this.lo = v;
    if (v > this.hi) this.hi = v;
    if (++this.n === this.perColumn) this.flush();
  }

  private flush(): void {
    this.out.push((this.lo >> 8) + 128, (this.hi >> 8) + 128);
    this.n = 0;
    this.lo = 32767;
    this.hi = -32768;
  }

  /** The pairs (a last, shorter column is kept). */
  finish(): Uint8Array {
    if (this.n) this.flush();
    return Uint8Array.from(this.out);
  }
}

/** What the prep runs: FFmpeg for a finished file, and FFmpeg's PCM as it comes. Tests give fakes. */
export interface PrepRunner {
  /** FFmpeg's report of a file (`ffmpeg -i`, which exits with an error: only the text matters). */
  probe(file: string): Promise<string>;
  /** Runs FFmpeg to the end; rejects when it fails. */
  run(args: string[]): Promise<void>;
  /** Runs FFmpeg and hands its stdout to `onData` as it comes; rejects when it fails. */
  stream(args: string[], onData: (chunk: Uint8Array) => void): Promise<void>;
}

/** The real runner over an FFmpeg program. */
export function ffmpegRunner(ffmpeg: string): PrepRunner {
  return {
    probe: (file) => new Promise((resolve) => execFile(ffmpeg, ["-hide_banner", "-i", file], { timeout: 30_000, windowsHide: true }, (_e, _o, stderr) => resolve(String(stderr)))),
    run: (args) => new Promise((resolve, reject) => execFile(ffmpeg, args, { windowsHide: true, maxBuffer: 1 << 20 }, (err, _o, stderr) => (err ? reject(new Error(String(stderr).slice(-300) || err.message)) : resolve()))),
    stream: (args, onData) => new Promise((resolve, reject) => {
      const p = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      p.stdout.on("data", onData);
      p.stderr.on("data", (d: Buffer) => (err = (err + d).slice(-300)));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `ffmpeg exited with ${code}`))));
    }),
  };
}

const metaOf = (dir: string): string => join(dir, "status.json");

/** The status kept in a prep folder, if a finished prep is there (a cache hit). */
export async function readDone(dir: string, id: string): Promise<PrepStatus | undefined> {
  try {
    const s = JSON.parse(await readFile(metaOf(dir), "utf8")) as PrepStatus;
    return s.id === id && s.state === "done" ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Makes the proxy, sprite and peaks of a file into `dir` (each is written under a temporary name and renamed, so a
 * half-made file is never served). `onStatus` hears every step.
 *
 * @param r - The runner.
 * @param input - The original file.
 * @param dir - The prep folder of this file.
 * @param id - The file's key.
 * @param onStatus - Called with the status as it changes.
 * @returns The finished status.
 */
export async function prepare(r: PrepRunner, input: string, dir: string, id: string, onStatus: (s: PrepStatus) => void = () => undefined): Promise<PrepStatus> {
  await mkdir(dir, { recursive: true });
  const text = await r.probe(input);
  const v = probeText(text);
  const duration = durationOf(text);
  if (!duration || (!v.w && !v.audio)) throw new Error("This file has no picture or sound FFmpeg can read.");
  const kind = v.w ? "video" : "audio";
  const st: PrepStatus = { id, state: "running", kind, duration, ready: { proxy: false, sprite: false, peaks: false } };
  const step = (s: PrepStep): void => onStatus({ ...st, step: s, ready: { ...st.ready } });
  const tmp = (name: string): string => join(dir, `.tmp-${name}`);
  const proxy = kind === "video" ? "proxy.mp4" : "proxy.m4a";

  step("proxy");
  await r.run(kind === "video" ? proxyArgs(input, tmp(proxy), v.fps) : audioProxyArgs(input, tmp(proxy)));
  await rename(tmp(proxy), join(dir, proxy));
  st.ready.proxy = true;

  if (kind === "video") {
    step("sprite");
    const layout = spriteLayout(duration);
    // From the 480 p proxy just made, not the original: the same 160 px thumbnails, about 5 times faster (measured: a 2 min
    // 1080 p file, 9.0 s from the original, 1.8 s from the proxy).
    await r.run(spriteArgs(join(dir, proxy), tmp("sprite.jpg"), layout));
    await rename(tmp("sprite.jpg"), join(dir, "sprite.jpg"));
    await writeFile(join(dir, "sprite.json"), JSON.stringify(layout));
    st.sprite = layout;
    st.ready.sprite = true;
  }

  if (kind === "audio" || v.audio) {
    step("peaks");
    const b = new PeaksBuilder();
    await r.stream(pcmArgs(input), (c) => b.push(c));
    const peaks = b.finish();
    await writeFile(tmp("peaks.bin"), peaks);
    await rename(tmp("peaks.bin"), join(dir, "peaks.bin"));
    st.peaks = { rate: PEAK_RATE, perColumn: PEAKS_PER_COLUMN, columns: peaks.length / 2 };
    st.ready.peaks = true;
  }

  const done: PrepStatus = { ...st, state: "done" };
  await writeFile(metaOf(dir), JSON.stringify(done));
  return done;
}

/** A byte range from a Range header: `undefined` for none, `"bad"` when it cannot be met (416), else the bytes. */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | "bad" | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return undefined;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start >= size || start > end ? "bad" : { start, end };
}

/** Removes a prep folder (for a file that changed or a cleaned cache). */
export const dropPrep = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });
