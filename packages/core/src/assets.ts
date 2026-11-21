import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Asset, AssetKind } from "@kesher/shared";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "model/gltf-binary": "glb",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
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
   * Every asset with its file's size, newest first (for the bank of everything made).
   *
   * @returns The assets; a broken record is skipped.
   */
  async list(): Promise<Array<Asset & { size: number }>> {
    const out: Array<Asset & { size: number }> = [];
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      try {
        const asset = JSON.parse(await readFile(join(this.dir, name), "utf8")) as Asset;
        const st = await stat(this.fileOf(asset));
        out.push({ ...asset, size: st.size });
      } catch {
        // A record without its file (or a broken record) is not shown.
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * The full path of an asset's file.
   *
   * @param asset - The asset's record.
   * @returns The file's path.
   */
  fileOf(asset: Pick<Asset, "id" | "mimeType">): string {
    return join(this.dir, `${asset.id}.${EXTENSIONS[asset.mimeType] ?? "bin"}`);
  }

  /**
   * An asset's record without its bytes.
   *
   * @param id - Asset id.
   * @returns The record, or undefined.
   */
  async recordOf(id: string): Promise<Asset | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    return readFile(join(this.dir, `${id}.json`), "utf8").then((t) => JSON.parse(t) as Asset, () => undefined);
  }

  /**
   * Deletes an asset (its file and its record).
   *
   * @param id - Asset id.
   * @returns Whether it was there.
   */
  async delete(id: string): Promise<boolean> {
    const found = await this.recordOf(id);
    if (!found) return false;
    await rm(this.fileOf(found), { force: true });
    await rm(join(this.dir, `${id}.json`), { force: true });
    return true;
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
