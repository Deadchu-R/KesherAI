import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Asset, AssetKind } from "@kesher/shared";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "text/plain": "txt",
};

/**
 * Stores every generated file with its metadata. An asset is two files in
 * the assets folder: `<id>.<ext>` and `<id>.json`.
 *
 * Assets are how models pass work to each other: a video model receives an
 * image by asset id, not by re-uploading it.
 */
export class AssetStore {
  /** @param dir - The assets folder. */
  constructor(private readonly dir: string) {}

  /**
   * Saves a file and returns its asset record.
   *
   * @param data - File bytes.
   * @param mimeType - e.g. `image/png`.
   * @param extra - Source model and metadata.
   * @returns The new asset.
   */
  async save(data: Uint8Array, mimeType: string, extra: Pick<Asset, "sourceModelId" | "meta"> = {}): Promise<Asset> {
    const id = randomUUID();
    const kind: AssetKind = (["image", "video", "audio", "text"].find((k) => mimeType.startsWith(k)) as AssetKind) ?? "file";
    const asset: Asset = { id, kind, mimeType, createdAt: new Date().toISOString(), ...extra };
    await writeFile(join(this.dir, `${id}.${EXTENSIONS[mimeType] ?? "bin"}`), data);
    await writeFile(join(this.dir, `${id}.json`), JSON.stringify(asset, null, 2));
    return asset;
  }

  /**
   * Reads an asset and its bytes.
   *
   * @param id - Asset id.
   * @returns The asset and data, or `undefined` if it does not exist.
   */
  async get(id: string): Promise<{ asset: Asset; data: Buffer } | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    try {
      const asset = JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")) as Asset;
      const data = await readFile(join(this.dir, `${id}.${EXTENSIONS[asset.mimeType] ?? "bin"}`));
      return { asset, data };
    } catch {
      return undefined;
    }
  }
}
