/**
 * Turns a browser recording (CdpPage.startRecording / stopRecording: PNG frames with times) into a file for the chat:
 * a looping GIF, made here with no extra software (gif.ts), or a WebM video when FFmpeg is already on the computer
 * (never downloaded for this; without it the recording becomes a GIF and says so).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RecordedFrame } from "./cdp.js";
import { decodePng, encodeGif } from "./gif.js";

const run = promisify(execFile);

/** The most frames a GIF gets (longer recordings keep every n-th frame), and how long the last one stays. */
const GIF_FRAMES = 120;
const LAST_MS = 1500;

/**
 * Each frame's time on screen: until the next one came (at least 80 ms, at most 5 s), the last one 1.5 s.
 *
 * @param frames - The frames in order.
 */
export function frameDelays(frames: RecordedFrame[]): number[] {
  return frames.map((f, i) => (i + 1 < frames.length ? Math.min(5000, Math.max(80, frames[i + 1]!.at - f.at)) : LAST_MS));
}

/**
 * Keeps at most `max` frames, evenly, adding the dropped frames' time to the kept ones.
 *
 * @returns The kept frames' indexes and delays.
 */
export function thinFrames(delays: number[], max: number): Array<{ i: number; delay: number }> {
  if (delays.length <= max) return delays.map((delay, i) => ({ i, delay }));
  const out: Array<{ i: number; delay: number }> = [];
  const step = delays.length / max;
  for (let k = 0; k < max; k++) {
    const from = Math.floor(k * step);
    const to = k + 1 === max ? delays.length : Math.floor((k + 1) * step);
    out.push({ i: from, delay: delays.slice(from, to).reduce((a, b) => a + b, 0) });
  }
  return out;
}

/**
 * Makes the recording's file.
 *
 * @param frames - The recording's PNG frames.
 * @param format - `gif` (default) or `webm`.
 * @param ffmpeg - FFmpeg's program if it is here (for WebM); not called for a GIF.
 * @returns The file, its type, and a note when a WebM became a GIF.
 */
export async function encodeRecording(frames: RecordedFrame[], format: "gif" | "webm" = "gif", ffmpeg?: () => Promise<string | undefined>): Promise<{ data: Buffer; mimeType: string; note?: string }> {
  if (!frames.length) throw new Error("The recording has no frames.");
  const delays = frameDelays(frames);
  let note: string | undefined;
  if (format === "webm") {
    const exe = await ffmpeg?.().catch(() => undefined);
    if (exe) return { data: await webm(exe, frames, delays), mimeType: "video/webm" };
    note = "FFmpeg is not on this computer, so the recording is a GIF (WebM needs FFmpeg).";
  }
  const kept = thinFrames(delays, GIF_FRAMES);
  const gif = encodeGif(kept.map((k) => ({ image: () => decodePng(frames[k.i]!.data), delayMs: k.delay })));
  return { data: Buffer.from(gif), mimeType: "image/gif", ...(note ? { note } : {}) };
}

/** A WebM (VP9) from the frames through FFmpeg's concat list, which keeps each frame's own time. */
async function webm(exe: string, frames: RecordedFrame[], delays: number[]): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "kesher-rec-"));
  try {
    const list: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const name = `f${String(i).padStart(4, "0")}.png`;
      await writeFile(join(dir, name), frames[i]!.data);
      list.push(`file '${name}'`, `duration ${(delays[i]! / 1000).toFixed(3)}`);
    }
    // The concat list needs the last file once more for its duration to count.
    list.push(`file 'f${String(frames.length - 1).padStart(4, "0")}.png'`);
    await writeFile(join(dir, "list.txt"), list.join("\n"));
    const out = join(dir, "out.webm");
    await run(exe, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-fps_mode", "vfr", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "38", "-deadline", "realtime", out], { cwd: dir, timeout: 120_000, windowsHide: true });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
