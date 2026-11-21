/**
 * Media job progress in the chat bubble (design ChatJobProgress): which steps are media jobs, and how a
 * `tool_progress` update joins what is known. No React here, so it is tested on its own.
 */
import type { JobProgress } from "@kesher/shared";

/** Tools whose step is a media job (a picture, video, sound or 3D model), shown with the job's progress and Cancel. */
export const MEDIA_JOB = /^(generate_image|generate_video|make_music|make_sound|animate_picture|make_3d|upscale_image|remove_background|make_pbr_texture|make_ui_sprite)$/;

/**
 * Merges a `tool_progress` update into what is known of the job: its step and phase, and the newest preview frame
 * (an update without a frame keeps the last one, so the picture does not blink).
 *
 * @param prev - What is known.
 * @param next - The update.
 * @returns The job's progress now.
 */
export function mergeProgress(prev: JobProgress | undefined, next: JobProgress): JobProgress {
  const preview = next.preview ?? prev?.preview;
  return { ...prev, ...next, ...(preview ? { preview } : {}) };
}
