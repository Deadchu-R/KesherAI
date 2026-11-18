import { execFile } from "node:child_process";

/** A kept stretch of the source video, in seconds. */
export interface Segment {
  from: number;
  to: number;
}

/** At most this many stretches, and only this long a video (12 hours), so a page cannot ask for anything silly. */
const MAX_SEGMENTS = 400;
const MAX_SECONDS = 12 * 3600;

/**
 * Checks the stretches a page asked to keep: numbers, in order of the edit, each at least a tenth of a second.
 *
 * @param given - What the page sent.
 * @returns The stretches, rounded to milliseconds.
 * @throws When they are not usable.
 */
export function checkSegments(given: unknown): Segment[] {
  if (!Array.isArray(given) || !given.length || given.length > MAX_SEGMENTS) throw new Error(`Send 1 to ${MAX_SEGMENTS} stretches to keep.`);
  return given.map((g) => {
    const from = Number((g as Segment)?.from), to = Number((g as Segment)?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > MAX_SECONDS || to - from < 0.1) throw new Error("Each stretch needs a start and an end, at least 0.1 s apart.");
    return { from: Math.round(from * 1000) / 1000, to: Math.round(to * 1000) / 1000 };
  });
}

/**
 * FFmpeg's arguments that keep the stretches, in this order, and join them (trim + concat; re-encoded so every cut is
 * on the exact frame, as an editor's export is).
 *
 * @param input - The source video.
 * @param output - The new video (.mp4).
 * @param segments - The stretches to keep.
 * @param audio - Whether the source has sound.
 * @returns The arguments.
 */
export function cutArgs(input: string, output: string, segments: readonly Segment[], audio: boolean): string[] {
  const parts = segments.map((s, i) => {
    const v = `[0:v]trim=start=${s.from}:end=${s.to},setpts=PTS-STARTPTS[v${i}]`;
    return audio ? `${v};[0:a]atrim=start=${s.from}:end=${s.to},asetpts=PTS-STARTPTS[a${i}]` : v;
  });
  const ins = segments.map((_, i) => (audio ? `[v${i}][a${i}]` : `[v${i}]`)).join("");
  const graph = `${parts.join(";")};${ins}concat=n=${segments.length}:v=1:a=${audio ? 1 : 0}[v]${audio ? "[a]" : ""}`;
  return ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-filter_complex", graph, "-map", "[v]", ...(audio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "160k"] : []), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output];
}

/**
 * Cuts a video to the stretches (with its sound; if it has none, without).
 *
 * @param ffmpeg - The FFmpeg program.
 * @param input - The source video.
 * @param output - The new video.
 * @param segments - The stretches to keep.
 */
export async function cutVideo(ffmpeg: string, input: string, output: string, segments: readonly Segment[]): Promise<void> {
  const run = (audio: boolean) =>
    new Promise<void>((resolve, reject) => {
      execFile(ffmpeg, cutArgs(input, output, segments, audio), { timeout: 60 * 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).slice(0, 400))) : resolve()));
    });
  try {
    await run(true);
  } catch (err) {
    // A video with no sound has no [0:a]: try again without it.
    if (!/matches no streams|0:a|Stream specifier/i.test((err as Error).message)) throw err;
    await run(false);
  }
}

/** A caption line, in seconds of the cut video. */
export interface Caption {
  start: number;
  end: number;
  text: string;
}

/**
 * Captions as an SRT file (the one every player reads beside a video of the same name).
 *
 * @param given - What the page sent: up to 5000 lines, each with a start, an end and text.
 * @returns The SRT text, or undefined when there is nothing usable.
 */
export function srtOf(given: unknown): string | undefined {
  if (!Array.isArray(given) || !given.length) return undefined;
  const t = (s: number) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  const lines = given.slice(0, 5000).flatMap((g) => {
    const start = Number((g as Caption)?.start), end = Number((g as Caption)?.end);
    const text = String((g as Caption)?.text ?? "").replace(/\r?\n{2,}/g, "\n").replace(/-->/g, "→").trim().slice(0, 500);
    return Number.isFinite(start) && Number.isFinite(end) && end > start && text ? [{ start, end, text }] : [];
  });
  return lines.length ? lines.map((l, i) => `${i + 1}\n${t(l.start)} --> ${t(l.end)}\n${l.text}\n`).join("\n") : undefined;
}
