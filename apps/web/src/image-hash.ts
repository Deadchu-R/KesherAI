/**
 * A picture's difference hash (dHash): shrunk to 9×8 grey, each pixel compared with its right neighbour, 64 bits.
 * Two pictures whose hashes differ in 5 bits or fewer look the same (another size, quality or format).
 */

/**
 * The 64 bits from a 9×8 grey picture (72 values, row by row).
 *
 * @param grey - 72 brightness values.
 * @returns The hash.
 */
export function dHashOf(grey: ArrayLike<number>): bigint {
  let h = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h = (h << 1n) | (grey[y * 9 + x]! > grey[y * 9 + x + 1]! ? 1n : 0n);
  return h;
}

/**
 * How many bits two hashes differ in.
 *
 * @param a - A hash.
 * @param b - Another.
 * @returns 0 (the same) to 64.
 */
export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/**
 * Loads a picture and hashes it (in the page, on a 9×8 canvas).
 *
 * @param url - The picture's address.
 * @returns Its hash.
 */
export async function dHash(url: string): Promise<bigint> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = 9;
  c.height = 8;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, 9, 8);
  const px = g.getImageData(0, 0, 9, 8).data;
  const grey = new Array<number>(72);
  for (let i = 0; i < 72; i++) grey[i] = px[i * 4]! * 0.299 + px[i * 4 + 1]! * 0.587 + px[i * 4 + 2]! * 0.114;
  return dHashOf(grey);
}
