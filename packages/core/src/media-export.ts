/**
 * Rendering a phone editor's `MediaEdit` on the PC: the FFmpeg arguments for the graph `mediaEditToFfmpeg` built, and
 * the progress FFmpeg prints. Nothing here starts a process (the route does), so it is tested on its own. The phone
 * sends file ids and the edit list only; the files are found on this PC.
 */
import type { MediaGraph } from "@kesher/shared";

/** The export sizes (picture height), quality names and frame rates the sheet offers; anything else is refused. */
export const EXPORT_SIZES = [720, 1080] as const;
export const EXPORT_QUALITIES = ["low", "medium", "high"] as const;
export const EXPORT_FPS = [24, 30, 60] as const;

/** What the sheet chose, checked. */
export interface ExportLook {
  height: (typeof EXPORT_SIZES)[number];
  fps: (typeof EXPORT_FPS)[number];
  quality: (typeof EXPORT_QUALITIES)[number];
}

/**
 * Checks what the page sent for the export's look; unknown values fall back to 720 p, 30 fps, medium.
 *
 * @param given - The page's choice (untrusted).
 */
export function checkLook(given: unknown): ExportLook {
  const g = (given ?? {}) as Record<string, unknown>;
  return {
    height: EXPORT_SIZES.find((h) => h === Number(g.height)) ?? 720,
    fps: EXPORT_FPS.find((f) => f === Number(g.fps)) ?? 30,
    quality: EXPORT_QUALITIES.find((q) => q === g.quality) ?? "medium",
  };
}

/** x264's constant rate factor for each quality (lower is better and bigger). */
const CRF = { low: 30, medium: 25, high: 20 } as const;

/**
 * The FFmpeg arguments that render a graph: the picture is fitted to the height (never enlarged) at the frame rate,
 * x264 + AAC in an MP4 with the index first; a sound-only graph is written as AAC in an M4A.
 *
 * @param graph - From `mediaEditToFfmpeg`.
 * @param output - The file to write (`.mp4`, or `.m4a` when the graph has no picture).
 * @param look - The checked look.
 * @returns The arguments (progress goes to stdout as `key=value` lines).
 */
export function exportArgs(graph: MediaGraph, output: string, look: ExportLook): string[] {
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"];
  for (const f of graph.inputs) args.push("-i", f);
  const fit = graph.video ? `;${graph.video}scale=-2:'min(${look.height},ih)',fps=${look.fps},format=yuv420p[vfinal]` : "";
  args.push("-filter_complex", graph.filter + fit);
  if (graph.video) args.push("-map", "[vfinal]", "-c:v", "libx264", "-preset", "veryfast", "-crf", String(CRF[look.quality]));
  else args.push("-vn");
  if (graph.audio) args.push("-map", graph.audio, "-c:a", "aac", "-b:a", "160k");
  args.push("-movflags", "+faststart", output);
  return args;
}

/**
 * The progress (0 to 1) in a chunk of FFmpeg's `-progress` output, or undefined when it holds none.
 *
 * @param text - A chunk of stdout.
 * @param total - The edit's length in seconds.
 */
export function progressOf(text: string, total: number): number | undefined {
  const all = [...text.matchAll(/out_time_(?:us|ms)=(\d+)/g)];
  const last = all.at(-1);
  if (!last || !(total > 0)) return undefined;
  // `out_time_ms` is in microseconds in every FFmpeg release (a long-standing naming quirk).
  return Math.min(1, Math.max(0, Number(last[1]) / 1e6 / total));
}
