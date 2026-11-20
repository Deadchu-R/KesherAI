/*
 * Pure helpers for what the chat shows inline (like Claude's answers): which player a file gets, which editor opens
 * it, the asset behind a link, a player's length as text, and the fact a "remember" call kept (for its Undo).
 * No React here, so node:test can check them.
 */

/** What a made file is, for the player and the editor. */
export type MediaKind = "image" | "video" | "audio" | "model";

const BY_EXT: Record<string, MediaKind> = {
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", bmp: "image", avif: "image",
  mp4: "video", webm: "video", mov: "video", m4v: "video", mkv: "video",
  mp3: "audio", wav: "audio", ogg: "audio", oga: "audio", flac: "audio", m4a: "audio", aac: "audio", opus: "audio",
  glb: "model", gltf: "model",
};

/**
 * The kind of a file, by its MIME type first and then by its name's extension.
 *
 * @param mime - e.g. `video/webm` (an asset's `content-type`); may be empty.
 * @param name - The file's name or path; may be empty.
 * @returns The kind, or null for anything without a player (a document, an .exe).
 */
export function mediaKindOf(mime?: string | null, name?: string | null): MediaKind | null {
  const top = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (top.startsWith("image/") && top !== "image/svg+xml") return "image";
  if (top.startsWith("video/")) return "video";
  if (top.startsWith("audio/")) return "audio";
  if (top === "model/gltf-binary" || top === "model/gltf+json") return "model";
  const ext = /\.([a-z0-9]+)$/i.exec((name ?? "").split(/[?#]/)[0]!)?.[1]?.toLowerCase();
  return ext ? BY_EXT[ext] ?? null : null;
}

/** The editor plugin for each kind (`plugins/<id>/`). */
export const EDITOR_FOR: Record<MediaKind, string> = { image: "image-editor", video: "video-editor", audio: "sound-editor", model: "model-editor" };

/**
 * The asset id in a link to KesherAI's own files (`/api/assets/<id>`, with or without the server's address or a
 * `?token=`), so the answer can show a player instead of a plain link.
 *
 * @param href - The link.
 * @returns The id, or null when it is not an asset link.
 */
export function assetIdOf(href: string): string | null {
  const m = /^(?:https?:\/\/[^/\s]+)?\/api\/assets\/([0-9a-f-]{36})(?:[?#].*)?$/i.exec(href.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * A player's length as text: `0:07`, `3:25`, `1:02:05`.
 *
 * @param seconds - The length; NaN or Infinity (a live stream) gives "".
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A memory topic as `GET /api/memory` sends it (only what Undo needs). */
export interface MemoryTopicView {
  id: string;
  title: string;
  facts: Array<{ text: string }>;
}

/**
 * Finds the fact a `remember` call kept, so "Undo" can delete exactly it. The store keeps the note with its spaces
 * folded and cut at 300 characters (memory-store.ts `add`), so the same is done here; the topic named in the call is
 * searched first, and the last match wins (a re-added fact moves to the end).
 *
 * @param topics - The memory's topics.
 * @param note - The call's `note`.
 * @param topic - The call's `topic`, when it gave one.
 * @returns The topic id and the fact's index, or null when it is gone (edited or deleted on the Memory page).
 */
export function findFact(topics: MemoryTopicView[], note: string, topic?: string): { topicId: string; index: number } | null {
  const key = note.replace(/\s+/g, " ").trim().slice(0, 300).toLowerCase();
  if (!key) return null;
  const want = (topic ?? "").trim().toLowerCase();
  const ordered = want ? [...topics.filter((t) => t.title.toLowerCase() === want), ...topics.filter((t) => t.title.toLowerCase() !== want)] : topics;
  for (const t of ordered) {
    for (let i = t.facts.length - 1; i >= 0; i--) if (t.facts[i]!.text.toLowerCase() === key) return { topicId: t.id, index: i };
  }
  return null;
}
