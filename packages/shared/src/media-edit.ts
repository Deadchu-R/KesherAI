/**
 * `MediaEdit`: the edit list of the phone video/music editor. One small JSON (a few KB) the phone sends to the PC,
 * which renders it with FFmpeg on the ORIGINAL files. The video part is the same shape as the video editor's
 * `Segment` list (`packages/core/src/video-cut.ts`); the sound part is new: up to {@link MAX_LANES} audio lanes, each
 * with a list of sound operations. {@link checkMediaEdit} validates what a page sent; {@link mediaEditToFfmpeg} builds
 * the filter graph (it never starts FFmpeg).
 */

/** The transitions between clips one may choose (FFmpeg's xfade). */
export const MEDIA_TRANSITIONS = ["fade", "fadeblack", "fadewhite", "wipeleft", "wiperight", "slideleft", "slideright", "slideup", "circleopen", "circleclose", "dissolve", "pixelize", "zoomin"];

/** At most this many audio lanes in v1 (Roee's default: voice, music, effects, one spare). */
export const MAX_LANES = 4;
const MAX_CLIPS = 400;
const MAX_OPS = 200;
const MAX_SOURCES = 24;
const MAX_SECONDS = 12 * 3600;

/** A kept stretch of a source file, in seconds of that file. */
export interface MediaClip {
  /** Index into the sources (0 = the file the editor opened). */
  src: number;
  from: number;
  to: number;
  /** 0.25 to 4; the sound keeps its pitch. */
  speed?: number;
  /** 0 to 2. */
  volume?: number;
  /** How it comes in after the clip before it: "cut" or one of {@link MEDIA_TRANSITIONS}. */
  into?: { kind: string; seconds: number };
}

/**
 * One sound operation. Times are seconds of the lane AS IT IS after the operations before this one (as a destructive
 * editor works), so the list reads top to bottom.
 * - `trim`: keep only a..b.
 * - `cut`: remove a..b (the rest closes up).
 * - `fade`: fade in or out over a..b.
 * - `gain`: louder or quieter by `db` (-60 to 24) over a..b.
 * - `silence`: insert `duration` seconds of silence at `at`.
 */
export type SoundOp =
  | { op: "trim"; a: number; b: number }
  | { op: "cut"; a: number; b: number }
  | { op: "fade"; a: number; b: number; dir: "in" | "out" }
  | { op: "gain"; a: number; b: number; db: number }
  | { op: "silence"; at: number; duration: number };

/** One audio lane: a source file, where it starts on the edit's timeline, its volume and its operations. */
export interface AudioLane {
  src: number;
  /** Seconds on the timeline where the lane starts. */
  start: number;
  /** 0 to 2. */
  volume?: number;
  ops: SoundOp[];
}

/** The whole edit. */
export interface MediaEdit {
  v: 1;
  /** The picture (and its own sound): clips in order. May be empty for a sound-only edit. */
  video: MediaClip[];
  /** Extra sound lanes mixed over the video's own sound (at most {@link MAX_LANES}). */
  lanes: AudioLane[];
  /** When set, every clip is fitted into this picture (needed when clips come from different files). */
  frame?: { w: number; h: number; fps: number };
}

/** What the builder needs to know of each source file. */
export interface MediaSource {
  file: string;
  /** Whether it has a sound track (default true). */
  audio?: boolean;
}

const num = (x: unknown): number => (typeof x === "number" ? x : NaN);
const ms = (x: number): number => Math.round(x * 1000) / 1000;
const bad = (msg: string): never => {
  throw new Error(msg);
};

/** Checks one time pair; the end must be after the start. */
function range(a: unknown, b: unknown, what: string): [number, number] {
  const x = num(a), y = num(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y > MAX_SECONDS || y - x < 0.01) bad(`${what} needs a start and an end, at least 0.01 s apart.`);
  return [ms(x), ms(y)];
}

/**
 * Checks and cleans an edit a page sent: numbers only, known operations, sources that exist, sizes capped.
 *
 * @param given - What the page sent (untrusted).
 * @param sources - How many source files were sent with it.
 * @returns The edit, rounded to milliseconds, defaults left out.
 * @throws With a readable message when it is not usable.
 */
export function checkMediaEdit(given: unknown, sources: number): MediaEdit {
  const g = given as Partial<MediaEdit> | null;
  if (!g || typeof g !== "object" || g.v !== 1) return bad("This is not a media edit (v 1).");
  if (!Number.isInteger(sources) || sources < 1 || sources > MAX_SOURCES) return bad(`Send 1 to ${MAX_SOURCES} source files.`);
  const clips = g.video ?? [], lanes = g.lanes ?? [];
  if (!Array.isArray(clips) || clips.length > MAX_CLIPS) return bad(`At most ${MAX_CLIPS} clips.`);
  if (!Array.isArray(lanes) || lanes.length > MAX_LANES) return bad(`At most ${MAX_LANES} sound lanes.`);
  if (!clips.length && !lanes.length) return bad("The edit is empty.");
  const src = (x: unknown): number => {
    const n = num(x);
    return Number.isInteger(n) && n >= 0 && n < sources ? n : bad("A clip names a file that was not sent.");
  };
  const video = clips.map((c): MediaClip => {
    const [from, to] = range(c?.from, c?.to, "A clip");
    const speed = c?.speed === undefined ? 1 : num(c.speed);
    if (!(speed >= 0.25 && speed <= 4)) bad("A clip's speed is 0.25 to 4.");
    const volume = c?.volume === undefined ? 1 : num(c.volume);
    if (!(volume >= 0 && volume <= 2)) bad("A clip's volume is 0 to 2.");
    const kind = String(c?.into?.kind ?? "");
    const into = kind === "cut" || MEDIA_TRANSITIONS.includes(kind) ? { kind, seconds: Math.min(1.5, Math.max(0.1, num(c?.into?.seconds) || 0.5)) } : undefined;
    return { src: src(c?.src ?? 0), from, to, ...(speed !== 1 ? { speed: Math.round(speed * 100) / 100 } : {}), ...(volume !== 1 ? { volume: Math.round(volume * 100) / 100 } : {}), ...(into ? { into } : {}) };
  });
  const outLanes = lanes.map((l): AudioLane => {
    const start = l?.start === undefined ? 0 : num(l.start);
    if (!(start >= 0 && start <= MAX_SECONDS)) bad("A lane starts between 0 and 12 hours.");
    const volume = l?.volume === undefined ? 1 : num(l.volume);
    if (!(volume >= 0 && volume <= 2)) bad("A lane's volume is 0 to 2.");
    if (!Array.isArray(l?.ops) || l.ops.length > MAX_OPS) return bad(`At most ${MAX_OPS} sound operations per lane.`);
    const ops = l.ops.map((o): SoundOp => {
      const kind = (o as { op?: unknown })?.op;
      if (kind === "silence") {
        const at = num((o as { at?: unknown }).at), d = num((o as { duration?: unknown }).duration);
        if (!(at >= 0 && at <= MAX_SECONDS && d >= 0.01 && d <= 3600)) bad("Silence needs a place and a length (0.01 s to 1 hour).");
        return { op: "silence", at: ms(at), duration: ms(d) };
      }
      if (kind !== "trim" && kind !== "cut" && kind !== "fade" && kind !== "gain") return bad("Unknown sound operation.");
      const [a, b] = range((o as { a?: unknown }).a, (o as { b?: unknown }).b, `A ${kind}`);
      if (kind === "fade") {
        const dir = (o as { dir?: unknown }).dir;
        if (dir !== "in" && dir !== "out") bad("A fade is in or out.");
        return { op: "fade", a, b, dir: dir as "in" | "out" };
      }
      if (kind === "gain") {
        const db = num((o as { db?: unknown }).db);
        if (!(db >= -60 && db <= 24)) bad("Gain is -60 to 24 dB.");
        return { op: "gain", a, b, db: Math.round(db * 10) / 10 };
      }
      return { op: kind, a, b };
    });
    return { src: src(l?.src), start: ms(start), ...(volume !== 1 ? { volume: Math.round(volume * 100) / 100 } : {}), ops };
  });
  let frame: MediaEdit["frame"];
  if (g.frame !== undefined) {
    const { w, h, fps } = g.frame;
    if (!(Number.isInteger(w) && Number.isInteger(h) && w >= 16 && h >= 16 && w <= 7680 && h <= 4320 && num(fps) >= 1 && num(fps) <= 240)) bad("The frame is a size and a frame rate.");
    frame = { w: w & ~1, h: h & ~1, fps };
  }
  return { v: 1, video, lanes: outLanes, ...(frame ? { frame } : {}) };
}

const f = (x: number): string => String(ms(x));

/** `atempo` takes 0.5 to 2 per step, so a speed outside it is chained (0.25 → 0.5,0.5; 4 → 2,2). */
function tempo(speed: number): string[] {
  if (speed === 1) return [];
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push("atempo=2");
    s /= 2;
  }
  while (s < 0.5) {
    out.push("atempo=0.5");
    s *= 2;
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${f(s)}`);
  return out;
}

/** One lane's chain of filters from `[in]` to the returned label; pieces are numbered with `tag`. */
function laneGraph(lane: AudioLane, input: number, has: boolean, tag: string): { parts: string[]; out: string } {
  const parts: string[] = [];
  let cur = `${tag}_0`;
  if (!has) throw new Error("A sound lane needs a file with sound.");
  parts.push(`[${input}:a]aresample=44100,aformat=channel_layouts=stereo[${cur}]`);
  let n = 0;
  const next = (): string => `${tag}_${++n}`;
  for (const o of lane.ops) {
    if (o.op === "trim") {
      const out = next();
      parts.push(`[${cur}]atrim=start=${f(o.a)}:end=${f(o.b)},asetpts=PTS-STARTPTS[${out}]`);
      cur = out;
    } else if (o.op === "fade") {
      const out = next();
      parts.push(`[${cur}]afade=t=${o.dir}:st=${f(o.a)}:d=${f(o.b - o.a)}[${out}]`);
      cur = out;
    } else if (o.op === "gain") {
      const out = next();
      parts.push(`[${cur}]volume=volume=${f(o.db)}dB:enable='between(t,${f(o.a)},${f(o.b)})'[${out}]`);
      cur = out;
    } else if (o.op === "cut") {
      const [p, q, p1, q1, out] = [next(), next(), next(), next(), next()];
      parts.push(`[${cur}]asplit[${p}][${q}]`, `[${p}]atrim=end=${f(o.a)},asetpts=PTS-STARTPTS[${p1}]`, `[${q}]atrim=start=${f(o.b)},asetpts=PTS-STARTPTS[${q1}]`, `[${p1}][${q1}]concat=n=2:v=0:a=1[${out}]`);
      cur = out;
    } else {
      const [p, q, p1, q1, z, out] = [next(), next(), next(), next(), next(), next()];
      parts.push(`[${cur}]asplit[${p}][${q}]`, `[${p}]atrim=end=${f(o.at)},asetpts=PTS-STARTPTS[${p1}]`, `[${q}]atrim=start=${f(o.at)},asetpts=PTS-STARTPTS[${q1}]`, `anullsrc=r=44100:cl=stereo,atrim=duration=${f(o.duration)}[${z}]`, `[${p1}][${z}][${q1}]concat=n=3:v=0:a=1[${out}]`);
      cur = out;
    }
  }
  const delay = Math.round(lane.start * 1000);
  const out = `${tag}_o`;
  const tail = [...(delay ? [`adelay=${delay}|${delay}`] : []), ...(lane.volume !== undefined && lane.volume !== 1 ? [`volume=${f(lane.volume)}`] : [])];
  parts.push(`[${cur}]${tail.length ? tail.join(",") : "anull"}[${out}]`);
  return { parts, out };
}

/** The result of {@link mediaEditToFfmpeg}. */
export interface MediaGraph {
  /** The input files, in FFmpeg's `-i` order (the sources as given). */
  inputs: string[];
  /** The `-filter_complex` text. */
  filter: string;
  /** The label to `-map` for the picture, if there is one. */
  video?: string;
  /** The label to `-map` for the sound, if there is one. */
  audio?: string;
  /** The video part's length in seconds (after speed and transitions); 0 for a sound-only edit. */
  duration: number;
}

/**
 * Builds the FFmpeg filter graph for an edit (no process is started). Video clips are trimmed, sped, fitted to the
 * frame, and joined pairwise (a plain join, or an xfade/acrossfade when the clip has its own way in). Sound lanes run
 * their operations in order, are delayed to their start and mixed (without level change) over the video's sound.
 *
 * @param edit - A checked edit ({@link checkMediaEdit}).
 * @param sources - The files the edit's `src` numbers point to.
 * @returns The inputs and graph; the caller adds codecs and the output name.
 */
export function mediaEditToFfmpeg(edit: MediaEdit, sources: readonly MediaSource[]): MediaGraph {
  const parts: string[] = [];
  const hasAudio = (i: number): boolean => sources[i]?.audio !== false;
  const mix: string[] = [];
  let video: string | undefined;
  let duration = 0;
  const vclips = edit.video;
  if (vclips.length) {
    const fit = edit.frame ? `,scale=${edit.frame.w}:${edit.frame.h}:force_original_aspect_ratio=decrease,pad=${edit.frame.w}:${edit.frame.h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${edit.frame.fps},format=yuv420p` : "";
    const lens: number[] = [];
    vclips.forEach((c, i) => {
      const speed = c.speed ?? 1;
      const len = (c.to - c.from) / speed;
      lens.push(len);
      parts.push(`[${c.src}:v]trim=start=${f(c.from)}:end=${f(c.to)},setpts=(PTS-STARTPTS)/${f(speed)}${fit}[v${i}]`);
      const at = [...tempo(speed), ...(c.volume !== undefined && c.volume !== 1 ? [`volume=${f(c.volume)}`] : [])];
      parts.push(hasAudio(c.src)
        ? `[${c.src}:a]atrim=start=${f(c.from)}:end=${f(c.to)},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo${at.length ? "," + at.join(",") : ""}[a${i}]`
        : `anullsrc=r=44100:cl=stereo,atrim=duration=${f(len)}[a${i}]`);
    });
    let vacc = "v0", aacc = "a0";
    duration = lens[0]!;
    for (let i = 1; i < vclips.length; i++) {
      const into = vclips[i]!.into;
      const last = i === vclips.length - 1;
      const [vo, ao] = [last ? "vout" : `vj${i}`, last ? "aout" : `aj${i}`];
      if (into && into.kind !== "cut") {
        const t = Math.min(into.seconds, duration / 2, lens[i]! / 2);
        parts.push(`[${vacc}][v${i}]xfade=transition=${into.kind}:duration=${f(t)}:offset=${f(duration - t)}[${vo}]`, `[${aacc}][a${i}]acrossfade=d=${f(t)}[${ao}]`);
        duration += lens[i]! - t;
      } else {
        parts.push(`[${vacc}][${aacc}][v${i}][a${i}]concat=n=2:v=1:a=1[${vo}][${ao}]`);
        duration += lens[i]!;
      }
      [vacc, aacc] = [vo, ao];
    }
    if (vclips.length === 1) {
      parts.push("[v0]null[vout]", "[a0]anull[aout]");
    }
    video = "[vout]";
    mix.push("[aout]");
  }
  edit.lanes.forEach((l, i) => {
    const g = laneGraph(l, l.src, hasAudio(l.src), `l${i}`);
    parts.push(...g.parts);
    mix.push(`[${g.out}]`);
  });
  let audio: string | undefined;
  if (mix.length === 1) audio = mix[0];
  else if (mix.length > 1) {
    parts.push(`${mix.join("")}amix=inputs=${mix.length}:duration=longest:normalize=0[mixed]`);
    audio = "[mixed]";
  }
  return { inputs: sources.map((s) => s.file), filter: parts.join(";"), ...(video ? { video } : {}), ...(audio ? { audio } : {}), duration: ms(duration) };
}
