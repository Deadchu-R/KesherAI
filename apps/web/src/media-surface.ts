/**
 * The video and sound chat surfaces (surfaces.ts; design ChatVideoSurface and ChatSoundSurface): their registry entries
 * and the plain logic of their card and panel (no React, no network, so it is tested on its own). The pieces they show
 * come from the PC's media prep (`/api/media/prep`, `/api/media/:id/(proxy|sprite|peaks)`; packages/core/src/media-prep.ts).
 */
import type { ChatSurface, SurfaceItem } from "./surfaces";

/** The video files and the sound files the surfaces open. */
export const VIDEO_FILES = /\.(mp4|mov|webm|mkv)$/i;
export const SOUND_FILES = /\.(mp3|wav|ogg|flac|m4a)$/i;

/** What the PC's media prep reports (the parts of packages/core `PrepStatus` the page uses). */
export interface PrepInfo {
  id: string;
  state: "queued" | "running" | "done" | "error";
  kind?: "video" | "audio";
  duration?: number;
  error?: string;
  ready: { proxy: boolean; sprite: boolean; peaks: boolean };
  sprite?: { cols: number; rows: number; w: number; h: number; every: number; count: number };
  peaks?: { rate: number; perColumn: number; columns: number };
}

/**
 * The video or sound a tool step made, from the step's result: the first made file's asset id.
 *
 * @param kind - `video` or `audio`.
 * @param tools - The tools that make it.
 * @returns The `fromResult` of a surface.
 */
function fromAssets(kind: "video" | "audio", tools: RegExp): NonNullable<ChatSurface["fromResult"]> {
  return (tool, ok, _output, made) => {
    const id = (kind === "video" ? made?.videoIds : made?.audioIds)?.[0];
    return ok && id && tools.test(tool) ? { kind, id } : undefined;
  };
}

/** The video surface: a card with a poster and a player, and a panel with in/out marks and a trim. */
export const videoSurface: ChatSurface = {
  id: "video",
  title: { he: "וידאו", en: "Video" },
  kinds: ["video"],
  fileTypes: VIDEO_FILES,
  fromResult: fromAssets("video", /^(generate_video|animate_picture)$/),
  card: () => import("./MediaSurface").then((m) => ({ default: m.VideoCard })),
  panel: () => import("./MediaSurface").then((m) => ({ default: m.VideoPanel })),
  panelClass: "media-panel",
  tools: ["generate_video", "animate_picture", "media_range"],
  phone: "view+ask",
  // The file itself: each trim is a new file in the chat's shared/ folder, listed in the panel.
  versions: "none",
};

/** The sound surface: a waveform card, and a panel with a range to select and play. */
export const soundSurface: ChatSurface = {
  id: "sound",
  title: { he: "סאונד", en: "Sound" },
  kinds: ["audio"],
  fileTypes: SOUND_FILES,
  fromResult: fromAssets("audio", /^(make_music|make_sound|speak_text)$/),
  card: () => import("./MediaSurface").then((m) => ({ default: m.SoundCard })),
  panel: () => import("./MediaSurface").then((m) => ({ default: m.SoundPanel })),
  panelClass: "media-panel",
  tools: ["make_music", "make_sound", "speak_text", "media_range"],
  phone: "view+ask",
  // The file itself: each trim is a new file in the chat's shared/ folder, listed in the panel.
  versions: "none",
};

/**
 * Min and max per drawn column from the PC's 8-bit peaks (a min,max byte pair per source column; 128 is silence), so a
 * whole file is never decoded in the page.
 *
 * @param peaks - The bytes of `/api/media/:id/peaks`.
 * @param width - How many columns to draw.
 * @returns For each column the lowest and highest value, each from -1 to 1.
 */
export function waveColumns(peaks: Uint8Array, width: number): Array<[number, number]> {
  const src = Math.floor(peaks.length / 2);
  const n = Math.max(0, Math.floor(width));
  if (!src || !n) return [];
  const out: Array<[number, number]> = [];
  for (let c = 0; c < n; c++) {
    const from = Math.floor((c * src) / n);
    const to = Math.max(from + 1, Math.floor(((c + 1) * src) / n));
    let lo = 255, hi = 0;
    for (let i = from; i < to && i < src; i++) {
      lo = Math.min(lo, peaks[i * 2]!);
      hi = Math.max(hi, peaks[i * 2 + 1]!);
    }
    out.push([(lo - 128) / 128, (hi - 128) / 128]);
  }
  return out;
}

/** A time as m:ss (h:mm:ss from an hour). */
export function clockText(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** A marked stretch, in seconds. */
export interface Marks {
  start: number;
  end: number;
}

/**
 * Puts two marked moments in order and inside the file; a stretch shorter than 0.1 s counts as none.
 *
 * @param a - One mark.
 * @param b - The other.
 * @param duration - The file's length.
 * @returns The range, or undefined.
 */
export function markRange(a: number, b: number, duration: number): Marks | undefined {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(duration, Math.max(a, b));
  return hi - lo >= 0.1 ? { start: Math.round(lo * 100) / 100, end: Math.round(hi * 100) / 100 } : undefined;
}

/** Where a time is on a bar, 0 to 1. */
export const fraction = (t: number, duration: number): number => (duration > 0 ? Math.min(1, Math.max(0, t / duration)) : 0);

/**
 * The thumbnail for a time, as the sprite's offsets (the sprite is `cols` thumbnails wide, one every `every` seconds).
 *
 * @param sprite - The prep's sprite index.
 * @param t - The time in seconds.
 * @returns The column and row, and the picture's size in thumbnails.
 */
export function spriteCell(sprite: NonNullable<PrepInfo["sprite"]>, t: number): { col: number; row: number } {
  const i = Math.min(sprite.count - 1, Math.max(0, Math.floor(t / sprite.every)));
  return { col: i % sprite.cols, row: Math.floor(i / sprite.cols) };
}

/** What "Ask about this range" sends to the chat: the file and the stretch (what the model's `media_range` tool takes). */
export interface RangeAsk {
  /** The file: a chat file's path, or a made file's asset id. */
  file: string;
  /** Which of the two `file` is. */
  by: "path" | "asset";
  start: number;
  end: number;
}

/**
 * The ask payload of a marked range on an item.
 *
 * @param item - The video or sound.
 * @param m - The marked stretch.
 */
export function rangeAsk(item: SurfaceItem, m: Marks): RangeAsk {
  return item.path ? { file: item.path, by: "path", start: m.start, end: m.end } : { file: item.id, by: "asset", start: m.start, end: m.end };
}

/**
 * The chat message for a marked range: a line the model reads (the `media_range` call to make) and the user's question.
 *
 * @param ask - The payload.
 * @param title - The file's name for the text.
 * @param question - What the user asked (may be empty: then "what happens here").
 * @param he - Whether to write in Hebrew.
 */
export function rangeMessage(ask: RangeAsk, title: string, question: string, he: boolean): string {
  const q = question.trim() || (he ? "מה קורה בקטע הזה?" : "What happens in this part?");
  const span = `${clockText(ask.start)}-${clockText(ask.end)}`;
  const head = he ? `על הקטע ${span} של "${title}"` : `About ${span} of "${title}"`;
  const hint = `[media_range ${ask.by}=${JSON.stringify(ask.file)} start=${ask.start} end=${ask.end}]`;
  return `${head}: ${q}\n${hint}`;
}
