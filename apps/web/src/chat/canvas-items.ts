/**
 * What the side canvas shows beside the chat (design ChatCanvas, beside documents in the same panel): a picture with
 * the chat's other pictures as its history, a PBR map set, or a code diff with the file's other diffs in this chat as
 * versions. No React here, so it is tested on its own.
 */

/** Something the side canvas opens. */
export type CanvasItem =
  | { kind: "image"; assetId: string; history: string[]; convId?: string }
  | { kind: "pbr"; title: string; maps: Record<string, string> }
  | { kind: "diff"; title: string; versions: string[]; current: number };

/** An event as the chat has it (only the fields read here). */
interface Ev {
  type: string;
  name?: string;
  ok?: boolean;
  diff?: string;
  assetIds?: string[];
  audioIds?: string[];
  callId?: string;
}

/** Steps whose pictures are of the screen (browser, computer), not made pictures. */
const SCREEN = /^(computer_|browser_)|screenshot/;

/**
 * The pictures made in a chat, in order: the history the canvas steps through and compares against. Screen pictures
 * and a song's cover are left out (as the chat shows them apart too).
 *
 * @param events - The chat's events.
 * @param also - A picture to make sure is in the list (the one being opened), added at the end when missing.
 */
export function imageHistory(events: readonly Ev[], also?: string): string[] {
  const ids = events.flatMap((e) => (e.type === "tool_result" && e.ok && !SCREEN.test(e.name ?? "") && !e.audioIds?.length ? e.assetIds ?? [] : []));
  const list = [...new Set(ids)];
  if (also && !list.includes(also)) list.push(also);
  return list;
}

/**
 * A file's diffs in this chat, in order, as the canvas's versions of it.
 *
 * @param events - The chat's events (tool calls and results).
 * @param path - The file (the call's `path`); "" gives just `diff`.
 * @param diff - The diff being opened (added when it is not among them).
 * @returns The versions and which one is `diff`.
 */
export function diffVersions(events: readonly (Ev & { input?: Record<string, unknown> })[], path: string, diff: string): { versions: string[]; current: number } {
  const pathOf = new Map(events.flatMap((e) => (e.type === "tool_call" && e.callId ? [[e.callId, typeof e.input?.path === "string" ? e.input.path : ""] as const] : [])));
  const versions = path ? events.flatMap((e) => (e.type === "tool_result" && e.diff && e.callId && pathOf.get(e.callId) === path ? [e.diff] : [])) : [];
  if (!versions.includes(diff)) versions.push(diff);
  return { versions, current: versions.lastIndexOf(diff) };
}

/**
 * The lines of a diff counted, for the canvas's header ("+12 −3").
 *
 * @param diff - A unified diff.
 */
export function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) added++;
    else if (l.startsWith("-") && !l.startsWith("---")) removed++;
  }
  return { added, removed };
}

/**
 * The zoom after a step in or out, kept between 10% and 1600%.
 *
 * @param zoom - The zoom now (1 = 100%).
 * @param dir - +1 in, -1 out.
 */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  return Math.min(16, Math.max(0.1, Math.round(zoom * (dir > 0 ? 1.25 : 0.8) * 100) / 100));
}
