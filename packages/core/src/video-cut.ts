import { execFile } from "node:child_process";
import { dirname } from "node:path";

/** A kept stretch of the source video, in seconds. */
export interface Segment {
  from: number;
  to: number;
  /** Another file's stretch (1 = the first of the added clips); none or 0 is the video the editor opened. */
  src?: number;
  /** Played faster or slower (0.25 to 4; its sound keeps its pitch). */
  speed?: number;
  /** Its sound louder or quieter (0 to 2). */
  volume?: number;
  /** How it comes in after the stretch before it, instead of the edit's transition: "cut" or one of TRANSITIONS. */
  into?: { kind: string; seconds: number };
}

/** A file added to the edit (the editors' "Add"): a video, or a picture shown for its stretch. */
export interface ExtraClip {
  file: string;
  kind: "video" | "image";
  /** Whether it has sound (a picture never does). */
  audio: boolean;
}

/** Text over the picture (the editor's "Text"): a picture of the words with a clear background, shown from start to end. */
export interface TextOverlay {
  /** A PNG the size of the frame, drawn in the page (so Hebrew and every font come out right). */
  file: string;
  /** Seconds of the edited video. */
  start: number;
  end: number;
}

/** The picture every stretch is fitted into when the edit has added clips: the opened video's size and frame rate. */
export interface Frame {
  w: number;
  h: number;
  fps: number;
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
export function checkSegments(given: unknown, extras = 0): Segment[] {
  if (!Array.isArray(given) || !given.length || given.length > MAX_SEGMENTS) throw new Error(`Send 1 to ${MAX_SEGMENTS} stretches to keep.`);
  return given.map((g) => {
    const from = Number((g as Segment)?.from), to = Number((g as Segment)?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > MAX_SECONDS || to - from < 0.1) throw new Error("Each stretch needs a start and an end, at least 0.1 s apart.");
    const src = Number((g as Segment)?.src ?? 0);
    if (!Number.isInteger(src) || src < 0 || src > extras) throw new Error("A stretch names a clip that was not sent.");
    const speed = Number((g as Segment)?.speed ?? 1);
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error("A stretch's speed is 0.25 to 4.");
    const volume = Number((g as Segment)?.volume ?? 1);
    if (!Number.isFinite(volume) || volume < 0 || volume > 2) throw new Error("A stretch's volume is 0 to 2.");
    // Its own way in: only "cut" or a listed transition, 0.1–1.5 s (anything else is dropped).
    const ik = String((g as Segment)?.into?.kind ?? "");
    const into = ik === "cut" || TRANSITIONS.includes(ik) ? { kind: ik, seconds: Math.min(1.5, Math.max(0.1, Number((g as Segment)?.into?.seconds) || 0.5)) } : undefined;
    return { from: Math.round(from * 1000) / 1000, to: Math.round(to * 1000) / 1000, ...(src ? { src } : {}), ...(speed !== 1 ? { speed: Math.round(speed * 100) / 100 } : {}), ...(volume !== 1 ? { volume: Math.round(volume * 100) / 100 } : {}), ...(into ? { into } : {}) };
  });
}

/** The shapes the export can cut the picture to. */
export const SHAPES = ["9:16", "1:1", "4:5", "16:9"];

/**
 * FFmpeg's arguments that keep the stretches, in this order, and join them (trim + concat; re-encoded so every cut is
 * on the exact frame, as an editor's export is).
 *
 * @param input - The source video.
 * @param output - The new video (.mp4).
 * @param segments - The stretches to keep.
 * @param audio - Whether the source has sound.
 * @param sound - Another file whose sound replaces the video's (the same times as the video).
 * @param burn - Captions to burn into the picture: a plain file name (letters, digits, -_.) of an .srt in FFmpeg's
 *   working folder, so no path has to be escaped for the filter (Windows' "C:" breaks it).
 * @param shape - A new shape for the picture, cut from its middle (CapCut's and Premiere's reframe, simply): "9:16" for
 *   phones and Reels, "1:1", "4:5" or "16:9"; none keeps it as it is.
 * @returns The arguments.
 */
/** The export's size and quality (CapCut's export: resolution and quality). */
export interface ExportLook {
  /** The picture's height at most (480, 720, 1080 or 2160); never made bigger than it is. */
  height?: number;
  /** "high" (bigger file), "normal" or "small" (smaller file). */
  quality?: "high" | "normal" | "small";
}
/** The transitions between clips one may choose (FFmpeg's xfade; CapCut's most used ones). */
export const TRANSITIONS = ["fade", "fadeblack", "fadewhite", "wipeleft", "wiperight", "slideleft", "slideright", "slideup", "circleopen", "circleclose", "dissolve", "pixelize", "zoomin"];
/** A transition between every two clips (CapCut's "Apply all"): which, and how long (0.1–1.5 s). */
export interface Transition {
  kind: string;
  seconds: number;
}
/** The export heights one may choose. */
export const EXPORT_HEIGHTS = [480, 720, 1080, 2160];
const CRF = { high: 17, normal: 20, small: 27 } as const;

/**
 * A music track under the video (CapCut's music lane, Premiere's Essential Sound "Music"): from where it starts in the
 * cut video, at a volume, faded in and out, and (as Premiere's auto-ducking) lowered under the voice by a side-chain
 * compressor that listens to the video's own sound.
 */
export interface MusicTrack {
  /** The music file (FFmpeg's second or third input). */
  file: string;
  /** Where it starts in the cut video, in seconds. */
  start: number;
  /** 0…1.5 (1 = as recorded). */
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** Lowered under the voice. */
  duck: boolean;
}

/**
 * The music track's part of the filter graph.
 *
 * @param m - The track.
 * @param input - Its FFmpeg input index.
 * @param total - The cut video's length (s).
 * @param voice - The video's sound label (e.g. "[a]"), or none when the video is silent.
 * @returns The graph's part, and the label of the sound that comes out.
 */
export function musicGraph(m: MusicTrack, input: number, total: number, voice?: string): { graph: string; out: string } {
  const n = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : 0));
  const start = n(m.start, 0, total), len = Math.max(0.1, total - start);
  const fi = n(m.fadeIn, 0, len / 2), fo = n(m.fadeOut, 0, len / 2), vol = n(m.volume, 0, 1.5);
  const ms = Math.round(start * 1000);
  let g = `[${input}:a]atrim=0:${len.toFixed(3)},asetpts=PTS-STARTPTS,volume=${vol.toFixed(3)}${fi ? `,afade=t=in:d=${fi.toFixed(3)}` : ""}${fo ? `,afade=t=out:st=${(len - fo).toFixed(3)}:d=${fo.toFixed(3)}` : ""}${ms ? `,adelay=${ms}|${ms}` : ""},apad=whole_dur=${total.toFixed(3)}[mu]`;
  if (!voice) return { graph: g, out: "[mu]" };
  // The voice keeps its level; the music is pressed down while the voice is there, and comes back after it.
  if (m.duck) g += `;${voice}asplit=2[vo][vk];[mu][vk]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[md];[vo][md]amix=inputs=2:duration=first:normalize=0[am]`;
  else g += `;${voice}[mu]amix=inputs=2:duration=first:normalize=0[am]`;
  return { graph: g, out: "[am]" };
}

/**
 * FFmpeg's arguments for a cut: the stretches in order, with the new sound, burned captions, a new shape and a music
 * track when given.
 *
 * @param input - The source video.
 * @param output - The new video.
 * @param segments - The stretches to keep.
 * @param audio - Whether the source has sound.
 * @param sound - A file whose sound replaces the video's.
 * @param burn - An .srt's plain name to burn in.
 * @param shape - One of SHAPES.
 * @param music - A music track under it.
 * @returns The arguments.
 */
export function cutArgs(input: string, output: string, segments: readonly Segment[], audio: boolean, sound?: string, burn?: string, shape?: string, music?: MusicTrack, more?: { clips: readonly ExtraClip[]; frame: Frame }, fade = 0, texts: readonly TextOverlay[] = [], look: ExportLook = {}, transition?: Transition): string[] {
  if (shape && !SHAPES.includes(shape)) throw new Error("Unknown shape.");
  if (burn && !/^[\w.-]+\.srt$/.test(burn)) throw new Error("The captions file name must be plain.");
  // With `sound` (a new sound for the video, from the sound editor), the sound comes from that second file instead.
  const a = sound ? "1:a" : "0:a";
  // Added clips (other videos, pictures): each stretch is fitted into the opened video's frame (letterboxed), at its
  // frame rate, with stereo sound at 48 kHz (silence where a clip has none), so concat can join them.
  const extra = more?.clips.length ? more : undefined;
  // A transition between clips, without overlapping them (so every time in the edit stays where it was): each clip's
  // last frame is held for the transition's length and blends into the start of the next one (FFmpeg's tpad + xfade).
  // Every stretch is then made the same frame size, rate and time base, which xfade needs.
  const all = transition && TRANSITIONS.includes(transition.kind) ? { kind: transition.kind, d: Math.min(1.5, Math.max(0.1, Number(transition.seconds) || 0.5)) } : undefined;
  // Each cut's way in: the stretch's own (a transition or a plain cut), else the edit's, else a cut.
  const ways = segments.map((g, i) => (i === 0 ? undefined : g.into ? (g.into.kind === "cut" ? undefined : { kind: g.into.kind, d: g.into.seconds }) : all));
  const tr = segments.length > 1 && more && ways.some(Boolean) ? { frame: more.frame } : undefined;
  const first = 1 + (sound ? 1 : 0) + (music ? 1 : 0);
  const frame = extra?.frame ?? tr?.frame;
  const fit = frame ? `,scale=${frame.w}:${frame.h}:force_original_aspect_ratio=decrease,pad=${frame.w}:${frame.h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${frame.fps},format=yuv420p${tr ? ",settb=AVTB" : ""}` : "";
  const af = ",aformat=sample_rates=48000:channel_layouts=stereo";
  // A dip to black between clips (CapCut's simplest transition): each stretch fades in and out, its sound too; never
  // longer than a third of the stretch.
  const dip = (len: number, i: number) => {
    const d = tr ? 0 : Math.min(Math.max(0, Number.isFinite(fade) ? fade : 0), 1, len / 3);
    if (!d || segments.length < 2) return { v: "", a: "" };
    const first = i === 0, last = i === segments.length - 1;
    const f = (k: "fade" | "afade") => `${first ? "" : `,${k}=t=in:st=0:d=${d.toFixed(3)}`}${last ? "" : `,${k}=t=out:st=${(len - d).toFixed(3)}:d=${d.toFixed(3)}`}`;
    return { v: f("fade"), a: f("afade") };
  };
  // A speed: the picture's timestamps divided by it, the sound through atempo (each step 0.5–2, so 0.25 and 4 take two).
  const tempo = (k: number, vol = 1) => (vol !== 1 ? `,volume=${vol.toFixed(2)}` : "") + (k === 1 ? "" : k < 0.5 ? `,atempo=0.5,atempo=${(k / 0.5).toFixed(4)}` : k > 2 ? `,atempo=2,atempo=${(k / 2).toFixed(4)}` : `,atempo=${k.toFixed(4)}`);
  const parts = segments.map((s, i) => {
    const c = s.src && extra ? extra.clips[s.src - 1] : undefined;
    const k = s.speed ?? 1;
    const vs = k === 1 ? "" : `,setpts=PTS/${k.toFixed(4)}`;
    const dp = dip((s.to - s.from) / k, i);
    const vin = c ? `${first + s.src! - 1}:v` : "0:v";
    const v = `[${vin}]trim=start=${s.from}:end=${s.to},setpts=PTS-STARTPTS${vs}${fit}${dp.v}[v${i}]`;
    if (!extra) return audio || sound ? `${v};[${a}]atrim=start=${s.from}:end=${s.to},asetpts=PTS-STARTPTS${tempo(k, s.volume)}${dp.a}[a${i}]` : v;
    const hasSound = c ? c.audio : audio || !!sound;
    const ain = c ? `${first + s.src! - 1}:a` : a;
    return hasSound ? `${v};[${ain}]atrim=start=${s.from}:end=${s.to},asetpts=PTS-STARTPTS${tempo(k, s.volume)}${af}${dp.a}[a${i}]` : `${v};anullsrc=r=48000:cl=stereo,atrim=duration=${((s.to - s.from) / k).toFixed(3)}[a${i}]`;
  });
  audio = audio || !!sound || !!extra;
  const ins = segments.map((_, i) => (audio ? `[v${i}][a${i}]` : `[v${i}]`)).join("");
  // Burned captions (CapCut's and Premiere's "burn in"): white with a dark outline, low in the frame, readable anywhere.
  // The new shape first, so the captions sit inside it: the largest middle part with that ratio, at even sizes for H.264.
  const [sw, sh] = (shape ?? "1:1").split(":").map(Number) as [number, number];
  const crop = shape ? `;[v]crop='min(iw,ih*${sw}/${sh})':'min(ih,iw*${sh}/${sw})',scale=trunc(iw/2)*2:trunc(ih/2)*2[vc]` : "";
  // A smaller size (only ever down, at even widths for H.264), after the shape and before the captions.
  const h = EXPORT_HEIGHTS.includes(look.height ?? 0) ? look.height! : 0;
  const sized = h ? `;${shape ? "[vc]" : "[v]"}scale=-2:'min(ih,${h})'[vh]` : "";
  const pic = h ? "[vh]" : shape ? "[vc]" : "[v]";
  const subs = burn ? `;${pic}subtitles=filename=${burn}:force_style='FontName=Arial,FontSize=20,Outline=2,Shadow=0,MarginV=28'[vs]` : "";
  // Text over the picture: each its own still input, laid over the whole frame while it shows (before the new shape,
  // so it is cut with the picture).
  const firstText = 1 + (sound ? 1 : 0) + (music ? 1 : 0) + (extra?.clips.length ?? 0);
  // Each fades in and out over a quarter second (a third of it when shorter), as CapCut's default text animation.
  const textChain = texts.map((t, k) => {
    const d = Math.min(0.25, (t.end - t.start) / 3).toFixed(3);
    const pic = `[${firstText + k}:v]format=rgba,fade=t=in:st=${t.start.toFixed(3)}:d=${d}:alpha=1,fade=t=out:st=${(t.end - Number(d)).toFixed(3)}:d=${d}:alpha=1[x${k}]`;
    return `${pic};[${k ? `t${k - 1}` : "vj"}][x${k}]overlay=0:0:enable='between(t,${t.start.toFixed(3)},${t.end.toFixed(3)})'[${k === texts.length - 1 ? "v" : `t${k}`}]`;
  }).join(";");
  const joined = texts.length ? "vj" : "v";
  let join = `${ins}concat=n=${segments.length}:v=1:a=${audio ? 1 : 0}[${joined}]${audio ? "[a]" : ""}`;
  if (tr) {
    // The picture: [v0] held and blended into [v1] at v0's end, that held and blended into [v2] at their end, and on;
    // each blend no longer than half the clip it blends into. The sound is joined as it is (it keeps every time).
    const lens = segments.map((g) => (g.to - g.from) / (g.speed ?? 1));
    let cur = "v0", at = lens[0]!;
    const steps: string[] = [];
    for (let i = 1; i < segments.length; i++) {
      const way = ways[i];
      const out = i === segments.length - 1 ? joined : `x${i}`;
      if (!way) {
        // A plain cut at this one.
        steps.push(`[${cur}][v${i}]concat=n=2:v=1:a=0[${out}]`);
      } else {
        const d = Math.max(0.04, Math.min(way.d, lens[i]! / 2)).toFixed(3);
        steps.push(`[${cur}]tpad=stop_mode=clone:stop_duration=${d}[p${i}];[p${i}][v${i}]xfade=transition=${way.kind}:duration=${d}:offset=${at.toFixed(3)}[${out}]`);
      }
      cur = out;
      at += lens[i]!;
    }
    join = steps.join(";") + (audio ? `;${segments.map((_, i) => `[a${i}]`).join("")}concat=n=${segments.length}:v=0:a=1[a]` : "");
  }
  let graph = `${parts.join(";")};${join}${texts.length ? `;${textChain}` : ""}${crop}${sized}${subs}`;
  // The music track, mixed with the video's sound (or alone, for a silent video).
  const total = segments.reduce((t, s) => t + (s.to - s.from) / (s.speed ?? 1), 0);
  let outA = audio ? "[a]" : "";
  if (music) {
    const m = musicGraph(music, sound ? 2 : 1, total, audio ? "[a]" : undefined);
    graph += `;${m.graph}`;
    outA = m.out;
  }
  // A picture is read as a still that lasts as long as its longest stretch.
  const extraInputs = (extra?.clips ?? []).flatMap((c, k) => {
    if (c.kind === "video") return ["-i", c.file];
    const until = Math.max(0.1, ...segments.filter((s) => s.src === k + 1).map((s) => s.to));
    return ["-loop", "1", "-framerate", String(extra!.frame.fps), "-t", until.toFixed(3), "-i", c.file];
  });
  const textInputs = texts.flatMap((t) => ["-loop", "1", "-t", Math.max(0.1, total).toFixed(3), "-i", t.file]);
  return ["-y", "-hide_banner", "-loglevel", "error", "-i", input, ...(sound ? ["-i", sound] : []), ...(music ? ["-i", music.file] : []), ...extraInputs, ...textInputs, "-filter_complex", graph, "-map", burn ? "[vs]" : pic, ...(outA ? ["-map", outA, "-c:a", "aac", "-b:a", "160k"] : []), "-c:v", "libx264", "-preset", "veryfast", "-crf", String(CRF[look.quality ?? "normal"] ?? 20), "-pix_fmt", "yuv420p", "-movflags", "+faststart", output];
}

/**
 * Cuts a video to the stretches (with its sound; if it has none, without).
 *
 * @param ffmpeg - The FFmpeg program.
 * @param input - The source video.
 * @param output - The new video.
 * @param segments - The stretches to keep.
 * @param sound - A file whose sound replaces the video's.
 * @param burn - An .srt beside the output to burn into the picture (its plain name; FFmpeg runs in that folder).
 * @param shape - One of SHAPES, or none.
 * @param music - A music track under it.
 */
export async function cutVideo(ffmpeg: string, input: string, output: string, segments: readonly Segment[], sound?: string, burn?: string, shape?: string, music?: MusicTrack, extras: ReadonlyArray<{ file: string; kind: "video" | "image" }> = [], fade = 0, texts: readonly TextOverlay[] = [], look: ExportLook = {}, transition?: Transition): Promise<void> {
  // With added clips: the opened video's frame, and which added videos have sound (FFmpeg reads their headers).
  let more: { clips: ExtraClip[]; frame: Frame } | undefined;
  if (extras.length || transition || segments.some((g) => g.into && g.into.kind !== "cut")) {
    const main = await probeMedia(ffmpeg, input);
    const clips = await Promise.all(extras.map(async (c) => ({ ...c, audio: c.kind === "video" && (await probeMedia(ffmpeg, c.file)).audio })));
    more = { clips, frame: { w: main.w || 1920, h: main.h || 1080, fps: main.fps || 30 } };
  }
  const run = (audio: boolean) =>
    new Promise<void>((resolve, reject) => {
      execFile(ffmpeg, cutArgs(input, output, segments, audio, sound, burn, shape, music, more, fade, texts, look, transition), { cwd: dirname(output), timeout: 60 * 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).slice(0, 400))) : resolve()));
    });
  try {
    await run(true);
  } catch (err) {
    // A video with no sound has no [0:a]: try again without it.
    if (!/matches no streams|0:a|Stream specifier/i.test((err as Error).message)) throw err;
    await run(false);
  }
}

/**
 * What FFmpeg says of a file's first video stream (size, frame rate) and whether it has sound, from `ffmpeg -i`.
 *
 * @param ffmpeg - The FFmpeg program.
 * @param file - The file.
 * @returns Its size and rate (0 when not found) and whether it has an audio stream.
 */
export function probeMedia(ffmpeg: string, file: string): Promise<{ w: number; h: number; fps: number; audio: boolean }> {
  return new Promise((resolve) => {
    execFile(ffmpeg, ["-hide_banner", "-i", file], { timeout: 30_000, windowsHide: true }, (_err, _out, stderr) => resolve(probeText(String(stderr))));
  });
}

/**
 * Reads `ffmpeg -i`'s report.
 *
 * @param text - What FFmpeg printed.
 * @returns The first video stream's size and frame rate, and whether there is an audio stream.
 */
export function probeText(text: string): { w: number; h: number; fps: number; audio: boolean } {
  const video = /Stream #[^\n]*Video:[^\n]*/.exec(text)?.[0] ?? "";
  const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(video);
  const fps = /([\d.]+) (?:fps|tbr)/.exec(video);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { w: size ? even(Number(size[1])) : 0, h: size ? even(Number(size[2])) : 0, fps: fps ? Math.min(120, Math.max(1, Math.round(Number(fps[1])))) : 0, audio: /Stream #[^\n]*Audio:/.test(text) };
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

/**
 * FFmpeg's arguments that take a video's sound out as a WAV (44.1 kHz, stereo), for the sound editor.
 *
 * @param input - The video.
 * @param output - The .wav.
 * @returns The arguments.
 */
export const soundArgs = (input: string, output: string): string[] => ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", output];

/**
 * Takes a video's sound out as a WAV.
 *
 * @param ffmpeg - The FFmpeg program.
 * @param input - The video.
 * @param output - The .wav.
 */
export function extractSound(ffmpeg: string, input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, soundArgs(input, output), { timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, _o, stderr) => (err ? reject(new Error(/matches no streams|does not contain any stream/i.test(String(stderr)) ? "This video has no sound." : String(stderr || err.message).slice(0, 400))) : resolve()));
  });
}

/**
 * FFmpeg's arguments to find where the picture changes shot (its scene score, as Premiere's Scene Edit Detection and
 * Resolve's Scene Cut Detector): every frame scoring over the threshold is printed by showinfo, nothing is written.
 *
 * @param input - The video.
 * @param threshold - How different a frame must be from the one before, 0–1 (0.3 is a cut; lower finds more).
 * @returns The arguments.
 */
export const sceneArgs = (input: string, threshold: number): string[] => ["-hide_banner", "-nostats", "-i", input, "-an", "-vf", `select='gt(scene,${threshold.toFixed(2)})',showinfo`, "-f", "null", "-"];

/**
 * The times (seconds) of shot changes in showinfo's output, in order, at least half a second apart.
 *
 * @param log - FFmpeg's stderr.
 * @returns The times.
 */
export function sceneTimes(log: string): number[] {
  const times: number[] = [];
  for (const m of log.matchAll(/pts_time:\s*([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t) && t > 0.2 && (!times.length || t - (times.at(-1) ?? 0) >= 0.5)) times.push(Math.round(t * 1000) / 1000);
  }
  return times;
}

/**
 * Finds where a video changes shot.
 *
 * @param ffmpeg - The FFmpeg program.
 * @param input - The video.
 * @param threshold - 0.05–0.9 (see sceneArgs).
 * @returns The times of the changes, in seconds.
 */
export function findScenes(ffmpeg: string, input: string, threshold = 0.3): Promise<number[]> {
  const th = Math.min(0.9, Math.max(0.05, threshold));
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, sceneArgs(input, th), { timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).slice(-400))) : resolve(sceneTimes(String(stderr)))));
  });
}
