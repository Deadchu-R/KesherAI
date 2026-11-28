/**
 * Pure helpers of the image surface (ImagePanel.tsx): which files and tool results open it, the rectangle a finger or
 * mouse picks on a picture (crop, "Ask about this area"), the new sizes of a resize, and the chat message that carries
 * a region. No React, so they run in `node:test`.
 */

/** The chat files the image surface opens (its "Open in chat" chip). */
export const IMAGE_FILES = /\.(png|jpe?g|webp|gif)$/i;

/** The agent tools whose pictures open it. */
export const IMAGE_TOOLS: readonly string[] = ["generate_image", "edit_image"];

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

/**
 * The picture a `generate_image` / `edit_image` step made.
 *
 * @param tool - The tool's name; `ok` and `output` its result.
 * @param assetIds - The step's picture ids when the chat has them; else the first id written in the output ("ids: …").
 * @returns The first picture's asset id, or undefined (another tool, a failure, or no picture).
 */
export function imageFromResult(tool: string, ok: boolean, output: string, assetIds?: readonly string[]): string | undefined {
  if (!ok || !IMAGE_TOOLS.includes(tool)) return undefined;
  // A failed edit says "No picture at <id>" / "Not edited: …": the id in it is the input's, not a new version.
  if (tool === "edit_image" && !assetIds?.length && !/^Edited\b/.test(output)) return undefined;
  return assetIds?.[0] ?? UUID.exec(output)?.[0];
}

/** A rectangle in the picture's own pixels. */
export interface Region { x: number; y: number; w: number; h: number }

/**
 * The rectangle two points (a drag) make on a picture, kept inside it; none when it is too small to mean anything.
 *
 * @param a - Where the drag began, in the picture's pixels; `b` where it is now.
 * @param size - The picture's width and height.
 * @param min - The smallest side that counts (default 8 pixels).
 * @returns The whole-pixel rectangle, or undefined.
 */
export function regionFromDrag(a: { x: number; y: number }, b: { x: number; y: number }, size: { w: number; h: number }, min = 8): Region | undefined {
  const cl = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
  const x0 = cl(Math.min(a.x, b.x), size.w);
  const y0 = cl(Math.min(a.y, b.y), size.h);
  const x1 = cl(Math.max(a.x, b.x), size.w);
  const y1 = cl(Math.max(a.y, b.y), size.h);
  const r = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
  return r.w >= min && r.h >= min ? r : undefined;
}

/**
 * The picture's pixel under a point of the screen, for a picture drawn inside `box`.
 *
 * @param p - The pointer, in screen pixels; `box` the picture's drawn rectangle; `size` its real size.
 * @returns The point in the picture's pixels (may be outside it; {@link regionFromDrag} clamps).
 */
export function toImagePoint(p: { x: number; y: number }, box: { left: number; top: number; width: number; height: number }, size: { w: number; h: number }): { x: number; y: number } {
  return { x: ((p.x - box.left) / box.width) * size.w, y: ((p.y - box.top) / box.height) * size.h };
}

/**
 * The new size of a resize from one edited side.
 *
 * @param size - The current size.
 * @param edit - Which side the user typed and its value.
 * @param lock - Keep the proportions (the other side follows).
 * @param max - The longest side allowed (the server's limit).
 * @returns The new whole-pixel size, each side 1 to `max`.
 */
export function resizeDims(size: { w: number; h: number }, edit: { side: "w" | "h"; value: number }, lock: boolean, max = 8192): { w: number; h: number } {
  const v = Math.min(max, Math.max(1, Math.round(edit.value) || 1));
  if (!lock) return edit.side === "w" ? { w: v, h: size.h } : { w: size.w, h: v };
  const k = v / (edit.side === "w" ? size.w : size.h);
  const other = Math.min(max, Math.max(1, Math.round((edit.side === "w" ? size.h : size.w) * k)));
  return edit.side === "w" ? { w: v, h: other } : { w: other, h: v };
}

/** A byte count for the card: "340 KB", "1.2 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What the server knows of a picture (`GET /api/images/:id/info`). */
export interface ImageInfo { id: string; mimeType: string; bytes: number; width?: number; height?: number; model?: string; prompt?: string; version: number; parent?: string }

/**
 * The chat message for a region of a picture: the picture's id, the rectangle (pixels and share of the picture) and
 * the request, so the model (or an edit tool) knows exactly which area is meant.
 *
 * @param p - The picture (`id`, `title`, its `size`), the `region`, the user's `instruction`, `change` (change only that area, else just ask) and `he`.
 */
export function regionMessage(p: { id: string; title: string; size: { w: number; h: number }; region: Region; instruction: string; change: boolean; he: boolean }): string {
  const { region: r, size } = p;
  const pct = (v: number, of: number) => Math.round((v / of) * 100);
  const where = `x=${r.x}, y=${r.y}, ${p.he ? "רוחב" : "width"}=${r.w}, ${p.he ? "גובה" : "height"}=${r.h} (${p.he ? "מתוך" : "of"} ${size.w}×${size.h}; ${pct(r.x, size.w)}%–${pct(r.x + r.w, size.w)}% ${p.he ? "לרוחב" : "across"}, ${pct(r.y, size.h)}%–${pct(r.y + r.h, size.h)}% ${p.he ? "לגובה" : "down"})`;
  const pic = `"${p.title}" (asset ${p.id})`;
  const ask = p.instruction.trim();
  if (!p.change) return p.he ? `בתמונה ${pic}, על האזור הזה: ${where}\n\n${ask}` : `In the picture ${pic}, about this area: ${where}\n\n${ask}`;
  return p.he
    ? `בתמונה ${pic}, לשנות רק את האזור הזה: ${where}\n\n${ask}\n(כל השאר נשאר בדיוק כמו שהוא; שמור כגרסה חדשה.)`
    : `In the picture ${pic}, change only this area: ${where}\n\n${ask}\n(Keep everything else exactly as it is; save it as a new version.)`;
}

/**
 * The chain of a picture's versions, oldest first, from each version's parent.
 *
 * @param info - What the server knows of the versions it was asked about (any order).
 * @param id - The newest picture.
 * @returns The ids from the first version to `id`; stops at a missing record or a loop.
 */
export function versionChain(info: ReadonlyMap<string, Pick<ImageInfo, "parent">>, id: string): string[] {
  const out: string[] = [];
  for (let at: string | undefined = id; at && !out.includes(at) && out.length < 50; at = info.get(at)?.parent) out.unshift(at);
  return out;
}

/**
 * A region as the contract's "selection" text (`x,y,w,h/W×H`), so the chat's selection message can name it.
 *
 * @param r - The region; `size` the picture's size.
 */
export function regionSelection(r: Region, size: { w: number; h: number }): string {
  return `${r.x},${r.y},${r.w},${r.h}/${size.w}×${size.h}`;
}

/** The region and picture size back from {@link regionSelection}'s text, or undefined when it is not one. */
export function parseRegionSelection(text: string): { region: Region; size: { w: number; h: number } } | undefined {
  const m = /^(\d+),(\d+),(\d+),(\d+)\/(\d+)×(\d+)$/.exec(text.trim());
  if (!m) return undefined;
  const n = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return { region: { x: n[0], y: n[1], w: n[2], h: n[3] }, size: { w: n[4], h: n[5] } };
}
