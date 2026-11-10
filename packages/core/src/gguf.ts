import { open } from "node:fs/promises";

/**
 * Reads a GGUF file's key/value header (not its tensors): the model's
 * architecture and settings, e.g. whether it carries a multi-token prediction
 * (MTP / NextN) head. Arrays are skipped without being read into memory (the
 * tokenizer's are megabytes), and reading stops after `maxBytes`.
 *
 * Format: "GGUF", version (u32), tensor count (u64), key/value count (u64),
 * then each key (u64 length + UTF-8), its type (u32) and its value.
 */

/** A value from the header (arrays are left out). */
export type GgufValue = number | bigint | boolean | string;

const SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

/**
 * Reads the header's scalar values.
 *
 * @param path - A `.gguf` file.
 * @param maxBytes - Stop after reading this much.
 * @returns Key → value, or undefined when the file is not GGUF.
 */
export async function readGgufHeader(path: string, maxBytes = 64 * 1024 ** 2): Promise<Map<string, GgufValue> | undefined> {
  const fh = await open(path, "r");
  try {
    let pos = 0;
    const buf = Buffer.alloc(8);
    const read = async (n: number): Promise<Buffer> => {
      const b = n <= 8 ? buf.subarray(0, n) : Buffer.alloc(n);
      const { bytesRead } = await fh.read(b, 0, n, pos);
      if (bytesRead < n) throw new Error("short read");
      pos += n;
      return b;
    };
    const u32 = async () => (await read(4)).readUInt32LE(0);
    const u64 = async () => (await read(8)).readBigUInt64LE(0);
    const str = async () => {
      const n = Number(await u64());
      if (n > 1024 * 1024) throw new Error("string too long");
      return (await read(n)).toString("utf8");
    };
    if ((await read(4)).toString("latin1") !== "GGUF") return undefined;
    await u32(); // version
    await u64(); // tensors
    const kvs = Number(await u64());
    const out = new Map<string, GgufValue>();
    for (let i = 0; i < kvs && pos < maxBytes; i++) {
      const key = await str();
      const type = await u32();
      if (type === 9) {
        // An array: skip it (strings one by one, numbers in one step).
        const t = await u32();
        const n = Number(await u64());
        if (t === 8) for (let j = 0; j < n && pos < maxBytes; j++) pos += 8 + Number((await read(8)).readBigUInt64LE(0));
        else pos += n * (SIZES[t] ?? 0);
        continue;
      }
      if (type === 8) {
        out.set(key, await str());
        continue;
      }
      const size = SIZES[type];
      if (!size) break;
      const b = await read(size);
      const v: GgufValue =
        type === 0 ? b.readUInt8(0) : type === 1 ? b.readInt8(0) : type === 2 ? b.readUInt16LE(0) : type === 3 ? b.readInt16LE(0) : type === 4 ? b.readUInt32LE(0) : type === 5 ? b.readInt32LE(0) : type === 6 ? b.readFloatLE(0) : type === 7 ? b.readUInt8(0) !== 0 : type === 10 ? b.readBigUInt64LE(0) : type === 11 ? b.readBigInt64LE(0) : b.readDoubleLE(0);
      out.set(key, v);
    }
    return out;
  } catch {
    return undefined;
  } finally {
    await fh.close();
  }
}

/**
 * How many MTP (NextN) layers a model file has (Qwen3.5–3.8, DeepSeek, GLM carry them as `<arch>.nextn_predict_layers`).
 *
 * @param path - A `.gguf` file.
 * @returns The count (0 when there are none or the file cannot be read).
 */
export async function mtpLayers(path: string): Promise<number> {
  const h = await readGgufHeader(path).catch(() => undefined);
  if (!h) return 0;
  for (const [k, v] of h) if (k.endsWith(".nextn_predict_layers")) return Number(v) || 0;
  return 0;
}
