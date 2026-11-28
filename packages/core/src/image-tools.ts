/**
 * The `edit_image` agent tool: crop, rotate, resize or repaint an area of a picture, so the image surface (apps/web
 * ImagePanel) reacts when the model edits a picture. Every edit is a NEW asset that remembers its parent
 * (`versionMeta`); the original is never changed. Crop, rotate and resize use `sharp` (image-ops.ts, loaded only when
 * used); "inpaint" repaints a rectangle through the active image model with a mask built here.
 */
import { readFile } from "node:fs/promises";
import type { AgentTool } from "@kesher/agent";
import { resolveInWorkspace } from "@kesher/agent";
import type { ConversationDeps } from "./conversation-deps.js";
import { checkRect, cropImage, imageSize, rectMaskPng, resizeImage, rotateImage, versionMeta, type SharpLoader } from "./image-ops.js";

/** The edits the tool offers. */
export const EDIT_OPS = ["crop", "rotate", "resize", "inpaint"] as const;
/** One of {@link EDIT_OPS}. */
export type EditOp = (typeof EDIT_OPS)[number];

const ASSET_ID = /^[0-9a-f-]{36}$/;
const MAX_BYTES = 40 * 1024 * 1024;

/** Where the tool gets its pieces from (tests pass fakes). */
export interface ImageToolIo {
  /** The picture: an asset id (the id of a picture shown in the chat) or a file in the chat's folder. */
  load(ref: string, workspace?: string): Promise<{ data: Uint8Array; mimeType: string; parent?: { id: string; meta?: Record<string, unknown> } } | undefined>;
  /** Saves the new version. */
  save(data: Uint8Array, mimeType: string, meta: Record<string, unknown>, sourceModelId?: string): Promise<{ id: string }>;
  /** Repaints the area (inpaint); undefined when no image model runs here. */
  inpaint?(o: { image: Uint8Array; mask: Uint8Array; prompt: string; width: number; height: number; signal?: AbortSignal }): Promise<{ data: Uint8Array; mimeType: string; model: string } | undefined>;
  sharp?: SharpLoader;
}

/**
 * Runs one edit.
 *
 * @param input - The model's input (untrusted): `image`, `op`, and the op's numbers (`x`, `y`, `width`, `height`,
 *   `degrees`, `prompt`).
 * @param io - Loading, saving, repainting.
 * @param workspace - The chat's folder (for a file path).
 * @param signal - Cancels a repaint.
 * @returns The tool's text and the id of the new version.
 */
export async function editImage(input: Record<string, unknown>, io: ImageToolIo, workspace?: string, signal?: AbortSignal): Promise<{ output: string; assetIds?: string[] }> {
  const op = String(input.op ?? "") as EditOp;
  if (!EDIT_OPS.includes(op)) return { output: `Unknown op. Use one of: ${EDIT_OPS.join(", ")}.` };
  const ref = String(input.image ?? "").replace(/^\[?Attached:\s*/i, "").replace(/\]$/, "").trim();
  const src = ref ? await io.load(ref, workspace) : undefined;
  if (!src) return { output: `No picture at "${ref}". Give the id of a picture shown in the chat, or a file in this chat's folder.` };
  if (src.data.length > MAX_BYTES) return { output: "The picture is too big to edit (over 40 MB)." };
  const size = imageSize(src.data);
  let out: Uint8Array | undefined;
  let mime = src.mimeType;
  let model: string | undefined;
  let what: string;
  try {
    if (op === "crop") {
      const r = checkRect(input, size);
      out = await cropImage(src.data, r, io.sharp);
      what = `cropped to ${r.width} x ${r.height}`;
    } else if (op === "rotate") {
      const d = Number(input.degrees);
      out = await rotateImage(src.data, d, io.sharp);
      what = `rotated ${d} degrees`;
    } else if (op === "resize") {
      const w = input.width === undefined ? undefined : Number(input.width);
      const h = input.height === undefined ? undefined : Number(input.height);
      out = (await resizeImage(src.data, { ...(w !== undefined ? { width: w } : {}), ...(h !== undefined ? { height: h } : {}), keep: input.keep === true }, io.sharp))?.data;
      what = `resized${w ? ` to width ${w}` : ""}${h ? ` height ${h}` : ""}`;
    } else {
      if (!size) return { output: "Cannot read this picture's size (only PNG, JPEG and GIF can be repainted)." };
      const prompt = String(input.prompt ?? "").trim().slice(0, 1000);
      if (!prompt) return { output: "Give a prompt (in English) for what to paint in the area." };
      const r = checkRect(input, size);
      if (!io.inpaint) return { output: "No image model that can repaint is ready. Ask the user to pick one under Models → Images." };
      const done = await io.inpaint({ image: src.data, mask: rectMaskPng(size.width, size.height, r), prompt, width: size.width, height: size.height, ...(signal ? { signal } : {}) });
      if (!done) return { output: "No image model that can repaint is ready. Ask the user to pick one under Models → Images." };
      ({ data: out, mimeType: mime, model } = done);
      what = `repainted in the area ${r.width} x ${r.height} at ${r.x},${r.y}`;
    }
  } catch (err) {
    return { output: `Not edited: ${(err as Error).message}` };
  }
  if (!out) return { output: "Not edited: the picture engine (sharp) is not available on this computer. Tell the user; the picture panel's own buttons still work." };
  const meta = src.parent ? versionMeta(src.parent, op) : { version: 1, op };
  const asset = await io.save(out, mime, meta, model);
  return { output: `Edited the picture (${what}) as a new version; the original is kept. The user can see it (id: ${asset.id}).`, assetIds: [asset.id] };
}

/**
 * The `edit_image` tool.
 *
 * @param deps - The manager's services.
 * @param usableModel - The active image model's id when it runs here (the same test `generate_image` uses).
 * @param sharp - Tests pass a fake `sharp`.
 */
export function editImageTool(deps: ConversationDeps, usableModel: () => string | undefined, sharp?: SharpLoader): AgentTool {
  const io: ImageToolIo = {
    ...(sharp ? { sharp } : {}),
    async load(ref, workspace) {
      if (ASSET_ID.test(ref)) {
        const f = await deps.assets.get(ref);
        return f && f.asset.kind === "image" ? { data: f.data, mimeType: f.asset.mimeType, parent: f.asset } : undefined;
      }
      if (!workspace) return undefined;
      // The chat's folder only, links followed (a plain relative() check let another drive's absolute path through on Windows).
      const file = await resolveInWorkspace(workspace, ref).catch(() => undefined);
      if (!file) return undefined;
      const data = await readFile(file).catch(() => undefined);
      const mimeType = /\.jpe?g$/i.test(ref) ? "image/jpeg" : /\.webp$/i.test(ref) ? "image/webp" : /\.png$/i.test(ref) ? "image/png" : undefined;
      return data && mimeType ? { data, mimeType } : undefined;
    },
    save: (data, mimeType, meta, sourceModelId) => deps.assets.save(data, mimeType, { ...(sourceModelId ? { sourceModelId } : {}), meta }),
    async inpaint(o) {
      const id = usableModel();
      if (!id) return undefined;
      const { provider, providerModelId } = deps.registry.resolve(id);
      const files = await provider.generateImage!({ providerModelId, prompt: o.prompt, width: o.width, height: o.height, steps: 0, seed: Math.floor(Math.random() * 2 ** 31), initImage: o.image, mask: o.mask }, o.signal);
      const f = files[0];
      return f ? { data: f.data, mimeType: f.mimeType, model: id } : undefined;
    },
  };
  return {
    risk: "safe",
    spec: {
      name: "edit_image",
      description: "Edit a picture and save the result as a NEW version (the original is kept): crop to a rectangle, rotate by a quarter turn, resize, or repaint a rectangular area from a prompt (inpaint). The user sees the new version in the picture panel. For a brand new picture use generate_image.",
      inputSchema: {
        type: "object",
        properties: {
          image: { type: "string", description: "The picture: the id of a picture shown in the chat, or a file in this chat's folder." },
          op: { type: "string", enum: [...EDIT_OPS] },
          x: { type: "integer", description: "crop / inpaint: the area's left edge in pixels." },
          y: { type: "integer", description: "crop / inpaint: the area's top edge in pixels." },
          width: { type: "integer", description: "crop / inpaint: the area's width; resize: the new width (1-8192)." },
          height: { type: "integer", description: "crop / inpaint: the area's height; resize: the new height (1-8192)." },
          keep: { type: "boolean", description: "resize: keep the proportions (fit inside)." },
          degrees: { type: "integer", description: "rotate: 90, 180, 270 or -90, clockwise." },
          prompt: { type: "string", description: "inpaint: what to paint in the area, in English." },
        },
        required: ["image", "op"],
      },
    },
    run: (input, ctx) => editImage(input, io, ctx.workspace, ctx.signal),
  };
}
