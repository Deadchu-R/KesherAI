/**
 * Screenshots in the chat: the computer and browser tools give the model a picture; the chat shows it as a small
 * thumbnail between the steps. The picture is kept as an asset (the existing media storage, not base64 inside the
 * messages), shrunk to at most 1280 px wide and written as a JPEG, so a long session stays light on disk and on the
 * phone's connection.
 */
import type { AgentTool } from "@kesher/agent";
import { decodePng, type Rgba } from "./gif.js";
import { encodeJpeg } from "./jpeg.js";

/** The widest a kept screenshot is. */
export const SHOT_MAX_WIDTH = 1280;

/** A kept picture: its bytes and type, and its size. */
export interface KeptShot {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Shrinks pixels to at most `maxWidth` wide (a box average, keeping the shape).
 *
 * @param img - The pixels.
 * @param maxWidth - The widest result.
 * @returns The same pixels when already narrow enough.
 */
export function shrinkRgba(img: Rgba, maxWidth = SHOT_MAX_WIDTH): Rgba {
  if (img.width <= maxWidth) return img;
  const w = maxWidth;
  const h = Math.max(1, Math.round((img.height * w) / img.width));
  const out = new Uint8Array(w * h * 4);
  const fx = img.width / w;
  const fy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.ceil((y + 1) * fy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.ceil((x + 1) * fx)));
      let r = 0, g = 0, b = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i]!; g += img.data[i + 1]!; b += img.data[i + 2]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * A screenshot ready to keep: a PNG shrunk to at most 1280 px wide and written as a JPEG. Anything this cannot read
 * (a JPEG already, an odd PNG) is kept as it came: a thumbnail is a nicety, never a reason to lose the picture.
 *
 * @param data - The picture's bytes.
 * @param mimeType - Its type.
 * @param maxWidth - The widest result.
 */
export function prepareShot(data: Buffer, mimeType: string, maxWidth = SHOT_MAX_WIDTH): KeptShot {
  if (mimeType === "image/png") {
    try {
      const px = shrinkRgba(decodePng(data), maxWidth);
      return { data: encodeJpeg(px), mimeType: "image/jpeg", width: px.width, height: px.height };
    } catch {
      /* fall through: keep as it came */
    }
  }
  return { data, mimeType, width: 0, height: 0 };
}

/** Saves a file as an asset and gives its id. */
export type SaveAsset = (data: Buffer, mimeType: string) => Promise<string>;

/**
 * Wraps a saver so every picture it keeps is shrunk and written as a JPEG first.
 *
 * @param save - The plain saver (the asset store).
 */
export function shotSaver(save: SaveAsset): SaveAsset {
  return (data, mimeType) => {
    const k = prepareShot(data, mimeType);
    return save(k.data, k.mimeType);
  };
}

/**
 * Makes the computer tools keep their pictures: a result that carries images (a screenshot, a zoom, the crop of
 * computer_find) and no asset yet gets one asset per image, so the chat shows them as thumbnails. The model still
 * receives the original images.
 *
 * @param tools - The tools.
 * @param save - Keeps a picture as an asset (already shrunk by {@link shotSaver}).
 */
export function withShotAssets(tools: AgentTool[], save: SaveAsset): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    run: async (input, ctx) => {
      const out = await tool.run(input, ctx);
      if (!out.images?.length || out.assetIds?.length) return out;
      const ids = (await Promise.all(out.images.slice(0, 2).map((im) => save(Buffer.from(im.data, "base64"), im.mimeType).catch(() => undefined)))).filter((x): x is string => !!x);
      return ids.length ? { ...out, assetIds: ids } : out;
    },
  }));
}
