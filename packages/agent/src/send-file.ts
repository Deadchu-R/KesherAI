import { copyFile, mkdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { MAX_FILE_CARDS_PER_TURN, fileCardKind, type FileCardDisplay, type FileCardInfo } from "@kesher/shared";
import type { AgentTool, ToolContext } from "./tools.js";
import { resolveForTool, resolveInWorkspace } from "./workspace.js";

/** Cards sent so far in the current turn (the turn's abort signal is the key; it lives as long as the turn). */
const SENT = new WeakMap<AbortSignal, number>();

/** The caption is one short line. */
const CAPTION_MAX = 300;

/**
 * Finds the file a card is made from and returns it as a path inside the chat's folder. The path must be in the
 * chat's folder or in a folder the user gave (the same guard as the file tools: `..` and links out are refused). A
 * file of a granted folder outside the chat's folder is copied into `sent/` there, so the download route (which
 * serves only the chat's folder) can stream it to the phone without opening any other path.
 *
 * @param ctx - The tool's context (workspace and granted folders).
 * @param path - The path the model gave.
 * @returns The path relative to the chat's folder (with `/`), the absolute file and its size.
 * @throws Error if the path is outside the allowed folders, is not a file, or the chat has no folder.
 */
export async function resolveSendable(ctx: Pick<ToolContext, "workspace" | "extraRoots">, path: string): Promise<{ rel: string; full: string; size: number }> {
  if (!ctx.workspace) throw new Error("This chat has no folder to send files from. Make the file with write_file in a chat that has a folder.");
  let full = await resolveForTool(ctx.workspace, ctx.extraRoots ?? [], path);
  let st = await stat(full).catch(() => undefined);
  if (!st?.isFile()) throw new Error(`${path} is not a file (a folder cannot be sent; zip it first).`);
  let rel = relative(await resolveInWorkspace(ctx.workspace, "."), full);
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
    // Outside the chat's folder, in a granted one: a copy under sent/ (a number added on a clash).
    const dir = await resolveInWorkspace(ctx.workspace, "sent");
    await mkdir(dir, { recursive: true });
    const ext = extname(full);
    const stem = basename(full, ext);
    let target = join(dir, basename(full));
    for (let n = 2; await stat(target).then(() => true, () => false); n++) target = join(dir, `${stem} (${n})${ext}`);
    await copyFile(full, target);
    full = target;
    st = await stat(full);
    rel = relative(await resolveInWorkspace(ctx.workspace, "."), full);
  }
  return { rel: rel.split(sep).join("/"), full, size: st.size };
}

/**
 * Posts a file into the chat as a card (name, size, type, caption, a preview for what has one, and Open, Show in
 * folder and Download buttons), like Claude's SendUserFile. At most 20 cards in a turn.
 */
export const sendFileTool: AgentTool = {
  risk: "read",
  spec: {
    name: "send_file",
    description: "Send a file to the user as a card in the chat: a picture, PDF, Markdown, web page, text or code, spreadsheet, zip or any file you made or were given. The user sees a preview and can open it, show it in its folder or download it (on the phone too). Use it for the deliverable files at the end of the work (and for drafts as soon as they are useful) instead of pasting long files into your reply. The file must be in the chat's folder or a folder you were given. At most 20 per turn.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file, relative to the project folder." },
        caption: { type: "string", description: "One short line about the file, in the user's language." },
        display: { type: "string", enum: ["render", "attach"], description: "render (default): show a preview in the card. attach: only the file's row." },
      },
      required: ["path"],
    },
  },
  async preview(input) {
    return `Send ${String(input.path ?? "")} to the chat`;
  },
  async run(input, ctx: ToolContext) {
    const sent = SENT.get(ctx.signal) ?? 0;
    if (sent >= MAX_FILE_CARDS_PER_TURN) throw new Error(`You already sent ${MAX_FILE_CARDS_PER_TURN} files in this turn. Zip the rest into one archive and send that.`);
    const { rel, size } = await resolveSendable(ctx, String(input.path ?? ""));
    SENT.set(ctx.signal, sent + 1);
    const display: FileCardDisplay = input.display === "attach" ? "attach" : "render";
    const caption = typeof input.caption === "string" ? input.caption.replace(/\s+/g, " ").trim().slice(0, CAPTION_MAX) : "";
    const name = rel.split("/").pop() ?? rel;
    const card: FileCardInfo = { path: rel, name, size, kind: fileCardKind(name), display, ...(caption ? { caption } : {}) };
    return { output: `Sent ${rel} (${size} bytes) to the chat as a card. The user can preview and download it; do not paste its content.`, files: [rel], cards: [card] };
  },
};

/** A document, sheet or deck the agent may open by its page address. */
const ITEM_REF = /^#\/(docs|sheets|slides)\/[\w-]{1,80}$/;

/**
 * Opens a chat file or a document, sheet or deck in the chat's side panel (full screen on the phone), in the
 * installed tool for its type (the interface picks it: surfaces.ts). When that tool is off, the user gets the
 * install offer on the card. Nothing is changed or copied, except a file of a granted folder outside the chat's
 * folder, which is copied into `sent/` as `send_file` does.
 */
export const openInChatTool: AgentTool = {
  risk: "read",
  spec: {
    name: "open_in_chat",
    description: "Open a file or a document in the chat's side panel, in the installed tool for its type (pictures in the picture editor, video, sound, 3D models, and documents, sheets and slides by their #/docs/<id>, #/sheets/<id> or #/slides/<id> address), so the user sees and edits it without leaving the chat. If the tool for that type is not installed, the user is offered to install it. Give path or item, not both.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "A file, relative to the project folder." },
        item: { type: "string", description: "A document, sheet or deck address: #/docs/<id>, #/sheets/<id> or #/slides/<id>." },
      },
    },
  },
  async preview(input) {
    return `Open ${String(input.path ?? input.item ?? "")} in the chat`;
  },
  async run(input, ctx: ToolContext) {
    const item = typeof input.item === "string" ? input.item.trim() : "";
    const path = typeof input.path === "string" ? input.path.trim() : "";
    if (!item === !path) throw new Error("Give either path (a file) or item (#/docs/<id>, #/sheets/<id> or #/slides/<id>).");
    if (item) {
      if (!ITEM_REF.test(item)) throw new Error("item must be #/docs/<id>, #/sheets/<id> or #/slides/<id>.");
      return { output: `Opened in the chat: ${item}\nThe user sees it in the side panel.` };
    }
    const { rel } = await resolveSendable(ctx, path);
    return { output: `Opened in the chat: ${rel}\nThe user sees it in the side panel, in the installed tool for its type (or is offered to install that tool).` };
  },
};
