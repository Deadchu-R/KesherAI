/**
 * Updates without GitHub: a computer serves the installer it has (one it built,
 * or the one it last downloaded and checked) to the user's other computers, in
 * the same shape as electron-builder's "generic" feed: `latest.yml` (version,
 * file names, sizes, sha512) plus the files it names. The other computers read
 * it through the device link (with that computer's token) and check the sha512
 * as they do for GitHub.
 */
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** The feed file for a system. */
export function feedName(platform = process.platform): string {
  return platform === "darwin" ? "latest-mac.yml" : platform === "linux" ? "latest-linux.yml" : "latest.yml";
}

/** One feed, read. */
export interface Feed {
  version: string;
  files: Array<{ name: string; size: number; sha512?: string }>;
}

/**
 * Reads an electron-builder feed (`latest.yml`).
 * @param yml - The feed's text.
 * @returns Its version and files, or undefined when it is not a feed.
 */
export function parseFeed(yml: string): Feed | undefined {
  const version = /^version:\s*['"]?([^'"\s]+)/m.exec(yml)?.[1];
  if (!version) return undefined;
  const files: Feed["files"] = [];
  // Each "- url:" starts a file; its sha512 and size follow until the next one.
  for (const block of yml.split(/^\s*-\s+url:/m).slice(1)) {
    const name = /^\s*['"]?([^'"\s]+)/.exec(block)?.[1];
    if (!name) continue;
    const sha512 = /^\s*sha512:\s*['"]?([^'"\s]+)/m.exec(block)?.[1];
    const size = Number(/^\s*size:\s*(\d+)/m.exec(block)?.[1] ?? 0);
    files.push({ name, size, ...(sha512 ? { sha512 } : {}) });
  }
  return { version, files };
}

/** A file name a feed may serve: a plain name, no folders. */
export function safeFeedFile(name: string): boolean {
  return /^[\w][\w .+-]{0,200}$/.test(name) && !name.includes("..") && basename(name) === name;
}

/**
 * The folder with the newest complete feed: its feed file and every file it names are there.
 * @param folders - Folders that may hold a feed (this computer's copy, a build's output).
 * @param platform - The system the feed is for.
 */
export function newestFeed(folders: string[], compare: (a: string, b: string) => number, platform = process.platform): { folder: string; feed: Feed } | undefined {
  let best: { folder: string; feed: Feed } | undefined;
  for (const folder of folders) {
    const path = join(folder, feedName(platform));
    if (!existsSync(path)) continue;
    let feed: Feed | undefined;
    try {
      feed = parseFeed(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!feed || !feed.files.length || !feed.files.every((f) => safeFeedFile(f.name) && existsSync(join(folder, f.name)))) continue;
    if (!best || compare(feed.version, best.feed.version) > 0) best = { folder, feed };
  }
  return best;
}

/**
 * Keeps a checked installer and its feed, so this computer can pass them on. Older files are removed.
 * @param dir - The folder kept for this.
 * @param installer - The installer, already checked against the feed's sha512.
 * @param yml - The feed it came with.
 */
export async function keepForFeed(dir: string, installer: string, yml: string, platform = process.platform): Promise<void> {
  const feed = parseFeed(yml);
  if (!feed || !feed.files.some((f) => f.name === basename(installer))) return;
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(dir)) if (f !== basename(installer)) await rm(join(dir, f), { force: true });
  await copyFile(installer, join(dir, basename(installer)));
  // Only the installer it has: the feed lists just that file.
  const own = feed.files.filter((f) => f.name === basename(installer));
  await writeFile(join(dir, feedName(platform)), `version: ${feed.version}\nfiles:\n${own.map((f) => `  - url: ${f.name}\n${f.sha512 ? `    sha512: ${f.sha512}\n` : ""}    size: ${f.size}\n`).join("")}`);
}

/**
 * Reads a single HTTP range (`bytes=a-b`, `bytes=a-`).
 * @param header - The Range header.
 * @param size - The file's size.
 * @returns The first and last byte, or undefined for a missing or unusable range.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  const m = /^bytes=(\d+)-(\d*)$/.exec(header ?? "");
  if (!m) return undefined;
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : undefined;
}
