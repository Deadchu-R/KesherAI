/**
 * The hand-off between the editors ("Edit in…"; docs/WORK_LIST.md "Editors call each other and offer to install a
 * missing one"; RESEARCH_LOG "editors that work alone but together"). Each editor stays a plugin of its own and saves
 * its own files; a hand-off is only **a file, where it came from and a way back**:
 *
 * 1. the first editor saves the file in the chat's folder and opens the second with a return ticket
 *    (`ret` = the file to reopen, `retp` = the editor, `slot` = where the result goes in it);
 * 2. the second shows a "Return to <editor>" chip, and its own Save/Back brings the result back (`back` + `slot`);
 * 3. if the second editor is not installed (its part is off), the Install window is shown first and the same action
 *    goes on once it is installed ({@link runHandoff}).
 *
 * Everything here is pure (no DOM, no network) so that the protocol is tested on its own; plugins.tsx wires it to the
 * page bridge. It works the same in remote: the addresses are hash routes and the files live in the chat's folder.
 */
import type { PageInput } from "./page-input";

/** The editors' plugin ids. */
export type EditorId = "image-editor" | "video-editor" | "sound-editor" | "model-editor";

/** What each editor opens (a link can hand an editor only a file of its own kind). */
export const EDITOR_FILES: Record<EditorId, RegExp> = {
  "image-editor": /\.(png|jpe?g|webp|gif|bmp)$/i,
  "video-editor": /\.(mp4|webm|mov|m4v|mkv)$/i,
  "sound-editor": /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i,
  "model-editor": /\.(glb|gltf)$/i,
};

/** A slot is an opaque place in the first editor (e.g. "Seat:map"); only these characters, so it is safe in an address. */
export const SLOT = /^[\p{L}\p{N}_:.\- ]{1,80}$/u;

/** The editors' names for chips and menus. */
export const EDITOR_NAMES: Record<EditorId, { he: string; en: string }> = {
  "image-editor": { he: "עורך התמונות", en: "the picture editor" },
  "video-editor": { he: "עורך הווידאו", en: "the video editor" },
  "sound-editor": { he: "עורך הסאונד", en: "the sound editor" },
  "model-editor": { he: "עורך התלת ממד", en: "the 3D editor" },
};

/** @returns Whether a string is an editor's plugin id. */
export function isEditor(id: string): id is EditorId {
  return Object.hasOwn(EDITOR_FILES, id);
}

/** What the page offers beside the editors: which optional tools exist on this computer. */
export interface Capabilities {
  /** A picture-to-3D tool exists (the chat's make_3d: Hunyuan3D / TRELLIS through ComfyUI). */
  image3d: boolean;
}

/** One entry of an editor's "Edit in…" menu. */
export interface EditAction {
  id: "texture" | "audio" | "make3d";
  from: EditorId;
  to: EditorId;
  he: string;
  en: string;
  /** The tool it needs; the entry is hidden when the computer has no such tool. */
  needs?: keyof Capabilities;
}

/** The "Edit in…" actions between the editors. */
export const EDIT_ACTIONS: readonly EditAction[] = [
  { id: "texture", from: "model-editor", to: "image-editor", he: "ערוך טקסטורה בעורך התמונות", en: "Edit texture in the picture editor" },
  { id: "audio", from: "video-editor", to: "sound-editor", he: "ערוך סאונד בעורך הסאונד", en: "Edit audio in the sound editor" },
  { id: "make3d", from: "image-editor", to: "model-editor", he: "צור מודל תלת ממד מזה", en: "Make a 3D model from this", needs: "image3d" },
];

/**
 * The "Edit in…" menu of an editor.
 *
 * @param from - The editor the menu is in.
 * @param caps - Which optional tools exist (an entry that needs a missing tool is hidden, never shown disabled).
 * @returns Its actions, in order.
 */
export function editInActions(from: EditorId, caps: Capabilities): EditAction[] {
  return EDIT_ACTIONS.filter((a) => a.from === from && (!a.needs || caps[a.needs]));
}

/** A request to open an asset in another editor. */
export interface OpenRequest {
  /** The editor asking. */
  from: EditorId;
  /** The editor to open. */
  to: EditorId;
  /** The chat whose folder holds the files. */
  chat: string;
  /** The file to open (chat path), of the target's kind. */
  file: string;
  /** The file the asking editor reopens on return (its own working copy or the file itself). */
  ret: string;
  /** Where in the asking editor the result goes. */
  slot: string;
  /** A guide drawn over the file and never saved (a model's UV layout over its texture). */
  guide?: string;
}

/**
 * Checks a request before anything is saved or opened.
 *
 * @param r - The request.
 * @returns The problem in words, or undefined when it is fine.
 */
export function checkRequest(r: OpenRequest): string | undefined {
  if (!isEditor(r.from) || !isEditor(r.to) || r.from === r.to) return "Hand off to another editor.";
  if (!/^[\w-]{1,80}$/.test(r.chat)) return "No chat.";
  if (!EDITOR_FILES[r.to].test(r.file)) return "That file is not one the editor opens.";
  if (!EDITOR_FILES[r.from].test(r.ret)) return "The way back is not a file of the first editor.";
  if (!SLOT.test(r.slot)) return "A short slot name.";
  if (r.guide !== undefined && !EDITOR_FILES["image-editor"].test(r.guide)) return "The guide is a picture.";
  return undefined;
}

/** @returns The hash route that opens the editor on a chat's file, with the return ticket. */
export function openHref(r: OpenRequest): string {
  const q = [`c=${encodeURIComponent(r.chat)}`, `f=${encodeURIComponent(r.file)}`, `ret=${encodeURIComponent(r.ret)}`, `retp=${r.from}`, `slot=${encodeURIComponent(r.slot)}`];
  if (r.guide) q.push(`g=${encodeURIComponent(r.guide)}`);
  return `#/p/${r.to}/editor?${q.join("&")}`;
}

/** The way back an opened editor carries. */
export interface ReturnTicket {
  plugin: EditorId;
  path: string;
  slot: string;
}

/**
 * The way back of a page that was opened by another editor: the generic ticket (`ret`/`retp`/`slot`) or the video
 * editor's own (the sound editor opened from a video knows only the video).
 *
 * @param input - What the page was opened with.
 * @returns Where "Return to…" goes, or undefined for a page that was not opened by an editor.
 */
export function ticketOf(input: Pick<PageInput, "returnTo" | "returnVideo"> | undefined): ReturnTicket | undefined {
  if (input?.returnTo && isEditor(input.returnTo.plugin)) return input.returnTo as ReturnTicket;
  if (input?.returnVideo) return { plugin: "video-editor", path: input.returnVideo, slot: "audio" };
  return undefined;
}

/** @returns The route of "Return to <editor>" without a result (the first editor reopens as it was left). */
export function returnChipHref(chat: string, t: ReturnTicket): string {
  return `#/p/${t.plugin}/editor?c=${encodeURIComponent(chat)}&f=${encodeURIComponent(t.path)}`;
}

/**
 * The route that brings a result back to the editor that asked.
 *
 * @param chat - The chat's id.
 * @param t - The return ticket.
 * @param result - The saved result (chat path).
 * @returns The route; the video editor gets the sound as `a` (its own contract), every other one `back` + `slot`.
 */
export function backHref(chat: string, t: ReturnTicket, result: string): string {
  const base = `#/p/${t.plugin}/editor?c=${encodeURIComponent(chat)}&f=${encodeURIComponent(t.path)}`;
  return t.plugin === "video-editor" ? `${base}&a=${encodeURIComponent(result)}` : `${base}&back=${encodeURIComponent(result)}&slot=${encodeURIComponent(t.slot)}`;
}

/** What {@link runHandoff} needs from the app (injected so the protocol is tested without a browser). */
export interface HandoffDeps {
  /** Whether an editor is installed (its part is on and its pages are loaded). */
  installed(id: EditorId): Promise<boolean>;
  /** Shows the Install window for an editor; resolves true once it is installed, false when the user cancels. */
  offerInstall(id: EditorId, why: string): Promise<boolean>;
  /** Goes to a route. */
  go(href: string): void;
}

/**
 * Opens an editor with a route, installing it first when it is missing, then goes on with the same action.
 *
 * @param deps - The app's hooks.
 * @param to - The editor to open.
 * @param href - Where to go once it is there.
 * @param why - What the user was doing, for the Install window.
 * @returns "opened"; "declined" when the user did not install it; "failed" when it was installed but did not come up.
 */
export async function runHandoff(deps: HandoffDeps, to: EditorId, href: string, why: string): Promise<"opened" | "declined" | "failed"> {
  if (!(await deps.installed(to))) {
    if (!(await deps.offerInstall(to, why))) return "declined";
    if (!(await deps.installed(to))) return "failed";
  }
  deps.go(href);
  return "opened";
}
