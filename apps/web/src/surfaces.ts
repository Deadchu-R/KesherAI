/**
 * Chat surfaces: how one installed component shows an item inside the chat (Roee 28.11: every installed tool opens,
 * edits and creates inside the chat; RESEARCH_LOG "2026-11-28 — every tool inside the chat"). The chat knows only this
 * registry and never imports a component itself: a surface's card and panel are loaded with `import()` the first time
 * they are shown, so a surface whose part is off adds about zero bytes to the chat.
 *
 * Display (Roee's decision): a card in the message, the side panel beside the chat, and full screen; under 1100 px
 * (the phone, also in remote) the panel opens full screen by itself (styles.css `.artifact-panel`).
 *
 * ## How to add a surface
 * 1. Write the panel: a React module whose component takes {@link SurfacePanelProps} (`item`, `full`, `onFull`) and
 *    closes with `closePanel()` from ArtifactPanel. Keep heavy libraries inside that module (or behind its own
 *    `import()`), never in this file.
 * 2. Add one entry to {@link BUILT_IN}: `id`, `title`, `kinds`, `fileTypes` (the files its "Open in chat" chip opens),
 *    `panel: () => import("./MyPanel").then((m) => ({ default: m.MyPanel }))`, the agent `tools` that make or change
 *    it, `phone` ("edit", "view+ask" or "open-on-pc"), `versions`, and when it applies `fromResult` (which tool step
 *    made which item), `card` (a small lazy preview in the message) and `selection` (the "ask about / change only
 *    this" message).
 * 3. If it belongs to a part (Settings → Parts) set `part`, and `plugin` when its page comes from a plugin: while that
 *    part is off (or its plugin is not loaded) the surface is not registered, and its files show the install offer.
 * 4. Test it in surfaces.test.ts (registered from parts, `fromResult`, the file types), in Hebrew and English, on a
 *    390 px phone and over remote.
 *
 * No React or network here (only types), so the registry is tested on its own; chat/surface-ui.tsx wires it to the
 * parts and plugins the server reports (`/api/parts`, `/api/plugins/ui`).
 */
import type { ComponentType } from "react";
import { ITEM_KINDS, itemFromResult as docFromResult, selectionMessage, type ItemKind } from "./doc-items";
import { CODE_FILES, askMessage, codeFileFromResult } from "./code-surface";
import { EDITOR_FILES, EDITOR_NAMES, type EditorId } from "./editor-handoff";

/** What a surface lets the phone do: edit there, view and ask the model, or only "Open on the PC". */
export type SurfacePhone = "edit" | "view+ask" | "open-on-pc";

/** One item open in a surface: which surface, its kind and id, the chat, a title, and a chat file when it is one. */
export interface SurfaceItem {
  surface: string;
  kind: string;
  /** The item's id (a document's id, or the chat file's path). */
  id: string;
  convId?: string;
  title?: string;
  /** A file in the chat's folder (path inside it, with `/`). */
  path?: string;
  /** The version a tool step made, for the card's "v3". */
  ver?: number;
  /** The unified diff a file-writing step made (the code surface's card counts it, its panel opens on it). */
  diff?: string;
}

/** What the panel shell gives a surface's panel. */
export interface SurfacePanelProps {
  item: SurfaceItem;
  full: boolean;
  onFull: () => void;
}

/** What the chat gives a surface's card in the message. */
export interface SurfaceCardProps {
  item: SurfaceItem;
  /** The version the step made. */
  ver?: number;
  /** The model is still working (a card that first shows then may open the panel on a wide screen). */
  live?: boolean;
}

/** A selection in a surface's panel, for its "ask about this / change only this" message. */
export interface SurfaceSelection {
  item: SurfaceItem;
  title: string;
  selection: string;
  instruction: string;
  change: boolean;
  he: boolean;
}

/** A module loaded on first use (React.lazy's shape). */
export type SurfaceLoader<P> = () => Promise<{ default: ComponentType<P> }>;

/** How one component shows its items in the chat. */
export interface ChatSurface {
  id: string;
  /** Its name for chips and menus. */
  title: { he: string; en: string };
  /** Item kinds it opens ("doc", "image", "model"...). */
  kinds: readonly string[];
  /** The chat files it opens (their "Open in chat" chip). */
  fileTypes?: RegExp;
  /** The part that must be on (Settings → Parts); none: always there. */
  part?: string;
  /** The plugin whose page it shows; registered only once that plugin's pages are loaded. */
  plugin?: string;
  /** Which item a tool step made or opened, from its result. */
  fromResult?(tool: string, ok: boolean, output: string): Omit<SurfaceItem, "surface"> | undefined;
  /** A small preview in the message (no heavy dependencies); none: the chat's plain card. */
  card?: SurfaceLoader<SurfaceCardProps>;
  /** The panel (loaded when it first opens). */
  panel: SurfaceLoader<SurfacePanelProps>;
  /** Extra class names on the panel shell (a surface's own styles). */
  panelClass?: string;
  /** Agent tools that make or change its items (names only; the part registers them). */
  tools: readonly string[];
  phone: SurfacePhone;
  /** The chat message for a part the user selected in the panel. */
  selection?(p: SurfaceSelection): string;
  /** "server": every hand edit and ask-edit saves a new version on the server; "none": the file itself. */
  versions: "server" | "none";
}

/** A document, sheet or deck: the same panel and card as before the registry (DocPanel.tsx). */
function docSurface(kind: ItemKind, title: { he: string; en: string }): ChatSurface {
  return {
    id: kind,
    title,
    kinds: [kind],
    fromResult: (tool, ok, output) => {
      const it = docFromResult(tool, ok, output);
      return it?.kind === kind ? it : undefined;
    },
    card: () => import("./DocPanel").then((m) => ({ default: m.ItemSurfaceCard })),
    panel: () => import("./DocPanel").then((m) => ({ default: m.ItemSurface })),
    panelClass: "doc-panel",
    tools: [ITEM_KINDS[kind].tool],
    phone: "edit",
    selection: (p) => selectionMessage({ kind, id: p.item.id, title: p.title, selection: p.selection, instruction: p.instruction, change: p.change, he: p.he }),
    versions: "server",
  };
}

/** Code files: the agent's `write_file` / `edit_file` results and "Open in chat" on a source file open the code panel (CodePanel.tsx). */
const CODE_SURFACE: ChatSurface = {
  id: "code",
  title: { he: "קוד", en: "Code" },
  kinds: ["code"],
  fileTypes: CODE_FILES,
  fromResult: (tool, ok, output) => {
    const path = codeFileFromResult(tool, ok, output);
    return path ? { kind: "code", id: path, path, title: path.split("/").pop() ?? path } : undefined;
  },
  card: () => import("./CodePanel").then((m) => ({ default: m.CodeCard })),
  panel: () => import("./CodePanel").then((m) => ({ default: m.CodePanel })),
  panelClass: "code-panel",
  tools: ["write_file", "edit_file"],
  phone: "edit",
  selection: (p) => askMessage({ path: p.item.path ?? p.item.id, selection: p.selection, from: 1, to: 1, instruction: p.instruction, change: p.change, he: p.he }),
  versions: "none",
};

/** The item kind and agent tools of each editor. */
const EDITOR_SURFACE: Record<EditorId, { kind: string; tools: readonly string[]; phone: SurfacePhone }> = {
  "image-editor": { kind: "image", tools: ["generate_image", "make_ui_sprite"], phone: "edit" },
  "video-editor": { kind: "video", tools: ["generate_video"], phone: "view+ask" },
  "sound-editor": { kind: "audio", tools: ["make_music", "make_sound", "speak_text"], phone: "view+ask" },
  "model-editor": { kind: "model", tools: [], phone: "edit" },
};

/** An editor plugin's page shown in the panel on a chat file (until it declares its own `ui.surfaces`). */
function editorSurface(id: EditorId): ChatSurface {
  const e = EDITOR_SURFACE[id];
  return {
    id,
    title: EDITOR_NAMES[id],
    kinds: [e.kind],
    fileTypes: EDITOR_FILES[id],
    part: id,
    plugin: id,
    panel: () => import("./chat/PluginSurface").then((m) => ({ default: m.PluginSurface })),
    panelClass: "plugin-surface",
    tools: e.tools,
    phone: e.phone,
    versions: "none",
  };
}

/** Every surface KesherAI knows, installed or not (the registry keeps the installed ones). */
export const BUILT_IN: readonly ChatSurface[] = [
  docSurface("doc", { he: "מסמך", en: "Document" }),
  docSurface("sheet", { he: "גיליון", en: "Sheet" }),
  docSurface("deck", { he: "מצגת", en: "Slides" }),
  CODE_SURFACE,
  ...(Object.keys(EDITOR_SURFACE) as EditorId[]).map(editorSurface),
];

/** What is installed: the parts and whether each is on, and the plugin pages that are loaded. */
export interface Installed {
  parts: ReadonlyArray<{ id: string; on: boolean }>;
  pluginPages: ReadonlyArray<{ pluginId: string }>;
}

/**
 * The surfaces to register: those with no part, and those whose part is on and whose plugin page is loaded. A part
 * the server does not list counts as on (as `partOn` does).
 *
 * @param defs - The surfaces to choose from.
 * @param inst - What the server reports as installed.
 * @returns The registered surfaces, in order.
 */
export function buildSurfaces(defs: readonly ChatSurface[], inst: Installed): ChatSurface[] {
  const off = new Set(inst.parts.filter((p) => !p.on).map((p) => p.id));
  const plugins = new Set(inst.pluginPages.map((p) => p.pluginId));
  return defs.filter((s) => (!s.part || !off.has(s.part)) && (!s.plugin || plugins.has(s.plugin)));
}

/**
 * The item a tool step made or opened, by the first registered surface that recognises it.
 *
 * @param list - The registered surfaces.
 * @param tool - The tool's name; `ok` and `output` its result.
 * @returns The item with its surface, or undefined.
 */
export function itemFromResult(list: readonly ChatSurface[], tool: string, ok: boolean, output: string): SurfaceItem | undefined {
  for (const s of list) {
    const it = s.fromResult?.(tool, ok, output);
    if (it) return { surface: s.id, ...it };
  }
  return undefined;
}

/** Where "Open in chat" goes for a file: a registered surface, the part to install first, or nothing. */
export type OpenTarget = { surface: ChatSurface } | { install: string; surface: ChatSurface } | undefined;

/**
 * Which surface opens a chat file, by its type.
 *
 * @param defs - Every known surface ({@link BUILT_IN}).
 * @param list - The registered ones.
 * @param name - The file's name or path.
 * @returns The registered surface; else a known one whose part is off, with the part to offer installing; else
 *   undefined (no installed tool opens this type).
 */
export function openTarget(defs: readonly ChatSurface[], list: readonly ChatSurface[], name: string): OpenTarget {
  const on = list.find((s) => s.fileTypes?.test(name));
  if (on) return { surface: on };
  const off = defs.find((s) => s.part && s.fileTypes?.test(name));
  return off?.part ? { install: off.part, surface: off } : undefined;
}

/** The first line of `open_in_chat`'s result: "Opened in the chat: <path or #/docs/<id>>". */
const OPENED = /^Opened in the chat: (.+)$/m;

/**
 * The chat file the agent opened with `open_in_chat` (items such as `#/docs/<id>` are the doc surfaces' own).
 *
 * @param tool - The tool's name; `ok` and `output` its result.
 * @returns The file's path inside the chat's folder, or undefined.
 */
export function openedFile(tool: string, ok: boolean, output: string): string | undefined {
  if (tool !== "open_in_chat" || !ok) return undefined;
  const p = OPENED.exec(output)?.[1]?.trim();
  return p && !p.startsWith("#/") ? p : undefined;
}
