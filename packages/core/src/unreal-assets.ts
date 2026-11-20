import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AssetEntry } from "@kesher/agent";
import { packageNameOf, readUassetFile, uassetSummary } from "./uasset.js";

/**
 * Unreal assets in the project index (step 7 of the engine-closed plan): each .uasset/.umap's class, parent class and
 * the /Game packages it uses, read from its header (uasset.ts) with no engine, kept by file time and size so only new
 * or changed files are read again. Gives the index real kinds (a "Blueprint" by class, not by its BP_ prefix) and
 * "used by" (the packages whose headers name this one).
 */

/** What the index keeps of one Unreal package. */
export interface UnrealAssetInfo {
  className?: string;
  kind?: string;
  parent?: string;
  /** /Game packages it imports (hard references). */
  uses: string[];
  /** /Game packages it references softly. */
  soft: string[];
}

/** Read headers by full path, with the file's time and size when read. */
const cache = new Map<string, { mtime: number; size: number; info: UnrealAssetInfo }>();
const MAX_CACHE = 200_000;
/** The index reads at most this much of each header (most are a few KB). */
const INDEX_BYTES = 2 * 1024 * 1024;

const UNREAL = /\.(uasset|umap)$/i;

/**
 * One package's info, from the cache while its time and size are the same, else from its header.
 *
 * @param abs - The file.
 * @returns Its info, or undefined when it is not there.
 */
export async function unrealAssetInfo(abs: string): Promise<UnrealAssetInfo | undefined> {
  const st = await stat(abs).catch(() => undefined);
  if (!st?.isFile()) return undefined;
  const hit = cache.get(abs);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.info;
  const h = await readUassetFile(abs, { maxBytes: INDEX_BYTES });
  const sum = uassetSummary(h, basename(abs).replace(/\.[^.]+$/, ""));
  const game = (list: string[]) => list.filter((p) => p.startsWith("/Game/"));
  const info: UnrealAssetInfo = { ...(sum.className ? { className: sum.className } : {}), ...(sum.kind ? { kind: sum.kind } : {}), ...(sum.parent ? { parent: sum.parent } : {}), uses: game(h.hardPackages), soft: game(h.softPackages) };
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(abs, { mtime: st.mtimeMs, size: st.size, info });
  return info;
}

/** An index entry with what its header said. */
export type IndexedAsset = AssetEntry & { className?: string; parent?: string };

/**
 * The project's assets with Unreal packages' kinds from their headers (others as they are). Reads up to the time
 * budget (8 at a time), so a first look at a big project returns quickly; files not read yet keep their name-based
 * kind and are read on the next call.
 *
 * @param root - The project folder.
 * @param assets - The asset list (listAssets).
 * @param budgetMs - How long new headers may be read for (default 2.5 s).
 * @returns The assets, and whether every Unreal package was read.
 */
export async function withUnrealKinds(root: string, assets: AssetEntry[], budgetMs = 2500): Promise<{ assets: IndexedAsset[]; complete: boolean }> {
  const until = Date.now() + budgetMs;
  const out: IndexedAsset[] = assets.slice();
  const todo = out.map((a, i) => [a, i] as const).filter(([a]) => UNREAL.test(a.path));
  let next = 0;
  let complete = true;
  const worker = async () => {
    while (next < todo.length) {
      if (Date.now() > until) {
        complete = false;
        return;
      }
      const [a, i] = todo[next++]!;
      const info = await unrealAssetInfo(join(root, a.path)).catch(() => undefined);
      if (info?.className) out[i] = { ...a, kind: info.kind ?? a.kind, className: info.className, ...(info.parent ? { parent: info.parent } : {}) };
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { assets: out, complete };
}

/**
 * The project's packages that use a package (hard or soft), from the headers read so far.
 *
 * @param root - The project folder.
 * @param assets - The project's assets (paths relative to it).
 * @param pkg - The package (/Game/Props/SM_Rock).
 * @returns Their paths (relative), at most 200, and whether all of them were known.
 */
export function usersOf(root: string, assets: AssetEntry[], pkg: string): { users: Array<{ path: string; soft: boolean }>; complete: boolean } {
  const users: Array<{ path: string; soft: boolean }> = [];
  let complete = true;
  for (const a of assets) {
    if (!UNREAL.test(a.path) || packageNameOf(a.path) === pkg) continue;
    const hit = cache.get(join(root, a.path));
    if (!hit) {
      complete = false;
      continue;
    }
    if (hit.info.uses.includes(pkg)) users.push({ path: a.path, soft: false });
    else if (hit.info.soft.includes(pkg)) users.push({ path: a.path, soft: true });
    if (users.length >= 200) break;
  }
  return { users, complete };
}
