import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { resolveForTool, type AgentTool } from "@kesher/agent";
import type { AssetStore } from "./assets.js";
import type { PrepRunner } from "./media-prep.js";

/**
 * Watch + ask (the chat's video and sound surfaces): the user marks a start and an end on a player or a waveform and
 * asks the model about that stretch. `media_range` lets the model look at it: a few frames of a video, and the stretch
 * of sound as a small WAV (which `transcribe_audio` can read). It only reads the original; what it makes goes under
 * `.ranges/` in the chat's folder.
 */

/** Most frames one call returns (each is a picture the model has to read). */
export const MAX_RANGE_FRAMES = 8;
/** The longest stretch one call looks at, in seconds. */
export const MAX_RANGE_SECONDS = 3600;
/** The longest stretch cut out as sound, in seconds (a WAV of 16 kHz mono is about 1.9 MB a minute). */
export const MAX_RANGE_AUDIO = 600;

/** A checked start and end, in seconds. */
export interface Range {
  start: number;
  end: number;
}

/**
 * Checks a start and an end: finite, not negative, the end after the start, and not longer than {@link MAX_RANGE_SECONDS}.
 *
 * @param start - Where the stretch begins, in seconds.
 * @param end - Where it ends.
 * @returns The range, to the millisecond.
 */
export function checkRange(start: unknown, end: unknown): Range {
  const a = Number(start), b = Number(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0) throw new Error("A range needs a start and an end in seconds.");
  if (b - a < 0.1) throw new Error("The end must be at least 0.1 s after the start.");
  if (b - a > MAX_RANGE_SECONDS) throw new Error(`A range is at most ${MAX_RANGE_SECONDS / 60} minutes.`);
  return { start: Math.round(a * 1000) / 1000, end: Math.round(b * 1000) / 1000 };
}

/**
 * The moments to take frames at: the middles of `count` equal parts of the range (a still one is one frame, the middle).
 *
 * @param r - The range.
 * @param count - How many frames (1 to {@link MAX_RANGE_FRAMES}).
 * @returns The times in seconds, rising.
 */
export function frameTimes(r: Range, count: number): number[] {
  const n = Math.min(MAX_RANGE_FRAMES, Math.max(1, Math.round(count) || 1));
  const step = (r.end - r.start) / n;
  return Array.from({ length: n }, (_, i) => Math.round((r.start + step * (i + 0.5)) * 1000) / 1000);
}

/** FFmpeg's arguments for one frame at `t`, 640 wide, as a JPEG. */
export const frameArgs = (input: string, t: number, output: string): string[] => ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", input, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", output];

/** FFmpeg's arguments for the sound of a range as a 16 kHz mono WAV (what speech recognition reads). */
export const rangeAudioArgs = (input: string, r: Range, output: string): string[] => ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(r.start), "-t", String(Math.round((r.end - r.start) * 1000) / 1000), "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output];

/** What {@link extractRange} made. */
export interface RangeOut {
  frames: Array<{ t: number; data: Buffer }>;
  /** The WAV of the range, when asked for. */
  audio?: string;
}

/**
 * Cuts a range of a file into frames and/or a WAV, with the given FFmpeg runner (tests give a fake one).
 *
 * @param r - The runner (only `run` is used).
 * @param input - The original file (never changed).
 * @param dir - Where the WAV goes (made when needed).
 * @param range - The checked range.
 * @param want - `frames`: how many pictures (0 for none); `audio`: the WAV too; `tag`: a name for the WAV.
 * @param tmp - A folder for the frames' temporary files.
 */
export async function extractRange(r: Pick<PrepRunner, "run">, input: string, dir: string, range: Range, want: { frames: number; audio: boolean; tag: string }, tmp: string): Promise<RangeOut> {
  const out: RangeOut = { frames: [] };
  if (want.frames > 0) {
    await mkdir(tmp, { recursive: true });
    try {
      let i = 0;
      for (const t of frameTimes(range, want.frames)) {
        const file = join(tmp, `frame-${i++}.jpg`);
        await r.run(frameArgs(input, t, file));
        out.frames.push({ t, data: await readFile(file) });
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  if (want.audio) {
    if (range.end - range.start > MAX_RANGE_AUDIO) throw new Error(`The sound of a range is at most ${MAX_RANGE_AUDIO / 60} minutes.`);
    await mkdir(dir, { recursive: true });
    const wav = join(dir, `${want.tag}.wav`);
    await r.run(rangeAudioArgs(input, range, wav));
    out.audio = wav;
  }
  return out;
}

/** The time as m:ss for the model's and the user's text. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** What `media_range` needs: an FFmpeg runner (found or downloaded on first use) and the asset store. */
export interface RangeDeps {
  runner: () => Promise<Pick<PrepRunner, "run">>;
  assets?: Pick<AssetStore, "recordOf" | "fileOf">;
}

/**
 * The `media_range` tool: frames and/or sound of a stretch of a video or sound file the user marked.
 *
 * @param d - The runner and assets.
 * @returns The tool (read-only: it never changes the original).
 */
export function mediaRangeTools(d: RangeDeps): AgentTool[] {
  return [{
    risk: "read",
    spec: {
      name: "media_range",
      description:
        "Look at a stretch of a video or sound file: a few frames (pictures) of a video between start and end, and/or the sound of that stretch as a WAV you can give to transcribe_audio. Use it when the user asks about a marked range (\"[media_range …]\" in their message) or about a moment in a clip. Times are in seconds. Give `path` (a file in this chat's folder) or `asset` (an id).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The video or sound file." },
          asset: { type: "string", description: "A made video or sound's id, instead of a path." },
          start: { type: "number", description: "Start, in seconds." },
          end: { type: "number", description: "End, in seconds." },
          frames: { type: "number", description: `How many frames to look at, 0-${MAX_RANGE_FRAMES} (default 4; a sound file has none).` },
          audio: { type: "boolean", description: "Also cut the sound of the range as a WAV (always for a sound file)." },
        },
        required: ["start", "end"],
      },
    },
    async run(input, ctx) {
      const range = checkRange(input.start, input.end);
      let file: string;
      if (typeof input.asset === "string" && input.asset) {
        const rec = await d.assets?.recordOf(input.asset);
        if (!rec || !d.assets) throw new Error("No such made file.");
        file = d.assets.fileOf(rec);
      } else {
        file = await resolveForTool(ctx.workspace, ctx.extraRoots ?? [], String(input.path ?? ""));
      }
      const isSound = /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(file) || /^audio\//.test((await d.assets?.recordOf(String(input.asset ?? "")))?.mimeType ?? "");
      const frames = isSound ? 0 : input.frames === undefined ? 4 : Math.min(MAX_RANGE_FRAMES, Math.max(0, Math.round(Number(input.frames)) || 0));
      const audio = isSound || input.audio === true;
      const base = basename(file, extname(file)).replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "clip";
      const tag = `${base}-${Math.round(range.start)}-${Math.round(range.end)}`;
      const folder = ctx.workspace ? join(ctx.workspace, ".ranges") : join(tmpdir(), "kesher-ranges");
      const made = await extractRange(await d.runner(), file, folder, range, { frames, audio, tag }, join(tmpdir(), `kesher-frames-${process.pid}-${tag}`));
      const lines = [`${basename(file)} from ${clock(range.start)} to ${clock(range.end)} (${range.start}-${range.end} s).`];
      if (made.frames.length) lines.push(`${made.frames.length} frame(s) at ${made.frames.map((f) => clock(f.t)).join(", ")} are attached.`);
      if (made.audio) lines.push(`Its sound is saved as ${ctx.workspace ? `.ranges/${basename(made.audio)}` : made.audio}; give that path to transcribe_audio to read what is said.`);
      return { output: lines.join(" "), ...(made.frames.length ? { images: made.frames.map((f) => ({ mimeType: "image/jpeg", data: f.data.toString("base64") })) } : {}) };
    },
  }];
}
