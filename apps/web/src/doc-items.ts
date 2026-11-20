/**
 * The documents, sheets and slide decks a chat's tools write (design DocPanel): which item a tool step made or
 * changed, and the message that asks about or changes a part of one. No React here, so it is tested on its own.
 */

/** The kinds of item the side panel opens. */
export type ItemKind = "doc" | "sheet" | "deck";

/** An item the side panel shows: its kind and id, the chat it was opened from, and the title known so far. */
export interface PanelItem {
  kind: ItemKind;
  id: string;
  convId?: string;
  title?: string;
}

/** Each kind's server path, page address, tool name and icon. */
export const ITEM_KINDS: Record<ItemKind, { api: string; page: string; tool: string; icon: string }> = {
  doc: { api: "/api/docs", page: "#/docs/", tool: "document", icon: "📄" },
  sheet: { api: "/api/sheets", page: "#/sheets/", tool: "sheet", icon: "📊" },
  deck: { api: "/api/decks", page: "#/slides/", tool: "slides", icon: "📑" },
};

const BY_TOOL: Record<string, ItemKind> = { document: "doc", sheet: "sheet", slides: "deck" };
const BY_PAGE: Record<string, ItemKind> = { docs: "doc", sheets: "sheet", slides: "deck" };

/**
 * The item a tool step wrote, from its result ("Saved v3 … The user sees it at #/docs/<id>"), or undefined for a
 * read, a failure or another tool.
 *
 * @param name - The tool's name.
 * @param ok - Whether the step worked.
 * @param output - The step's output.
 * @returns The item's kind, id and version number (when the output names one).
 */
export function itemFromResult(name: string, ok: boolean, output: string): { kind: ItemKind; id: string; ver?: number } | undefined {
  const kind = BY_TOOL[name];
  if (!kind || !ok || !/^Saved\b/.test(output)) return undefined;
  const at = /#\/(docs|sheets|slides)\/([\w-]{1,80})/.exec(output);
  if (!at || BY_PAGE[at[1]!] !== kind) return undefined;
  const ver = /^Saved v(\d+)/.exec(output)?.[1];
  return { kind, id: at[2]!, ...(ver ? { ver: Number(ver) } : {}) };
}

/**
 * The chat message for a part the user selected in the panel: a question about it, or a change to it through the
 * item's tool (only that part, read first). Long selections are cut, so the message stays short.
 *
 * @param p - The item (kind, id, title), the selected text, what the user wrote, whether it is a change, and
 *   `he`: whether to write the frame in Hebrew.
 */
export function selectionMessage(p: { kind: ItemKind; id: string; title: string; selection: string; instruction: string; change: boolean; he: boolean }): string {
  const sel = p.selection.trim().replace(/\s+\n/g, "\n");
  const quote = (sel.length > 1500 ? `${sel.slice(0, 1500)}…` : sel).split("\n").map((l) => `> ${l}`).join("\n");
  const what = p.he ? { doc: "במסמך", sheet: "בגיליון", deck: "במצגת" }[p.kind] : { doc: "In the document", sheet: "In the sheet", deck: "In the slides" }[p.kind];
  const where = `${what} "${p.title}" (${ITEM_KINDS[p.kind].page}${p.id})`;
  const ask = p.instruction.trim();
  if (!p.change) return p.he ? `${where}, על החלק הזה:\n${quote}\n\n${ask}` : `${where}, about this part:\n${quote}\n\n${ask}`;
  const tool = ITEM_KINDS[p.kind].tool;
  return p.he
    ? `${where}, לשנות את החלק הזה:\n${quote}\n\n${ask}\n(השתמש בכלי ${tool} עם id "${p.id}", קודם read, ושנה רק את החלק הזה.)`
    : `${where}, change this part:\n${quote}\n\n${ask}\n(Use the ${tool} tool with id "${p.id}", read first, and change only this part.)`;
}
