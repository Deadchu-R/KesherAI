/**
 * The plugin store (docs/PLUGINS.md → "Publish to the store"): a catalog kept in this repository
 * (`plugins/index.json`), and installing from it safely.
 *
 * The rules this module keeps (each one has a test in plugin-store.test.ts):
 * - The index is the allowlist. A plugin is installed only if it is listed, and its download address is built from the
 *   listed repository, version and file name, never taken from a request.
 * - The downloaded zip must match the `sha256` in the index before a single file is unpacked.
 * - Unpacking refuses any path that leaves the plugin folder (`..`, absolute paths, drive letters, backslashes) and
 *   limits the number and total size of files.
 * - The plugin's own `kesher-plugin.json` must agree with the index (same id and version) and may not ask for more
 *   than the index shows the user: what the user sees and presses on is what the plugin gets.
 * - The user must accept exactly the permissions listed (`accept`), so an old page or a changed index cannot slip a
 *   new permission in. Installing starts the plugin turned off; turning it on stays the user's press, on the computer.
 * - A phone can only request; the computer shows the approval card ({@link InstallRequests}).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import { z } from "zod";
import { PluginManifestSchema, type PluginManifest } from "@kesher/plugin-sdk";

/** Biggest zip the store accepts (bytes), and limits on what it unpacks. */
const MAX_ZIP = 50 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_UNPACKED = 150 * 1024 * 1024;

/**
 * What a plugin can ask for, in the words the store shows:
 * `files` (read and write outside its own folder), `network` (the internet), `models` (the local image, speech,
 * video, sound or 3D models) and `engines` (programs on this computer, such as a game engine or Blender).
 */
export const StorePermissionSchema = z.enum(["files", "network", "models", "engines"]);
/** One store permission; see {@link StorePermissionSchema}. */
export type StorePermission = z.infer<typeof StorePermissionSchema>;

/** A text in both languages. */
const Bilingual = z.object({ he: z.string().min(1).max(400), en: z.string().min(1).max(400) });

/** One plugin in `plugins/index.json`. */
export const StoreEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/, "lower-case letters, digits and '-'"),
  name: Bilingual,
  description: Bilingual,
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "semver, like 1.2.3"),
  author: z.string().min(1).max(80),
  /** The GitHub repository, `owner/name`. Its release `v<version>` holds the zip. */
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,60}\/[A-Za-z0-9_.-]{1,100}$/, "owner/name on GitHub"),
  /** Name of the zip file in the release. Default: `<id>.zip`. */
  asset: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\.zip$/).optional(),
  /** What it needs; the user sees this before pressing install. */
  permissions: z.array(StorePermissionSchema).max(4).default([]),
  /** Size of the zip in bytes; the download is cut off past it. */
  size: z.number().int().min(1).max(MAX_ZIP),
  /** Lower-case hex SHA-256 of the zip. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "64 hex digits, lower case"),
});
/** One store entry; see {@link StoreEntrySchema}. */
export type StoreEntry = z.infer<typeof StoreEntrySchema>;

/** The whole `plugins/index.json`. */
export const StoreIndexSchema = z.object({
  schema: z.literal(1),
  plugins: z.array(StoreEntrySchema).max(500),
});
/** The parsed index; see {@link StoreIndexSchema}. */
export type StoreIndex = z.infer<typeof StoreIndexSchema>;

/**
 * Checks an index file's contents.
 *
 * @param json - Parsed JSON.
 * @returns The index.
 * @throws If a field is wrong or two entries share an id.
 */
export function parseStoreIndex(json: unknown): StoreIndex {
  const index = StoreIndexSchema.parse(json);
  const seen = new Set<string>();
  for (const p of index.plugins) {
    if (seen.has(p.id)) throw new Error(`The index lists "${p.id}" twice.`);
    seen.add(p.id);
  }
  return index;
}

/**
 * Where an entry's zip is downloaded from. Built only from the listed fields.
 *
 * @param e - The index entry.
 * @returns An https GitHub release address.
 */
export function releaseUrl(e: StoreEntry): string {
  return `https://github.com/${e.repo}/releases/download/v${e.version}/${e.asset ?? `${e.id}.zip`}`;
}

/**
 * What a plugin's manifest asks for, in the store's words.
 *
 * @param m - A parsed `kesher-plugin.json`.
 * @returns Sorted store permissions.
 */
export function permissionsOfManifest(m: Pick<PluginManifest, "permissions" | "uses" | "programs">): StorePermission[] {
  const out = new Set<StorePermission>();
  if (m.permissions.includes("filesystem")) out.add("files");
  if (m.permissions.includes("network")) out.add("network");
  if (m.permissions.includes("shell") || m.programs.length > 0) out.add("engines");
  if (m.uses.some((u) => u !== "chat")) out.add("models");
  return [...out].sort();
}

/**
 * Compares two `x.y.z` versions.
 *
 * @returns Positive when `a` is newer than `b`, negative when older, 0 when equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * Whether what the user accepted is exactly what the entry asks for.
 *
 * @param entry - The index entry.
 * @param accept - The permissions the user pressed "install" on.
 */
export function acceptedAll(entry: Pick<StoreEntry, "permissions">, accept: unknown): boolean {
  if (!Array.isArray(accept)) return false;
  const a = new Set(accept.map(String));
  const need = new Set<string>(entry.permissions);
  return a.size === need.size && [...need].every((p) => a.has(p));
}

/**
 * A zip entry's name as a safe relative path, or `undefined` if it could leave the folder.
 *
 * @param name - The name inside the zip.
 */
export function safeEntryName(name: string): string | undefined {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return undefined;
  const parts = name.split("/").filter((p) => p !== "");
  if (parts.length === 0 || parts.some((p) => p === ".." || p === ".")) return undefined;
  return parts.join("/");
}

/**
 * Checks a downloaded zip against the index's hash.
 *
 * @param buf - The zip.
 * @param sha256 - Lower-case hex digest from the index.
 * @throws If they differ.
 */
export function verifySha256(buf: Uint8Array, sha256: string): void {
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== sha256.toLowerCase()) throw new Error("The downloaded file does not match the checksum in the store index, so it was not installed.");
}

/**
 * Downloads an entry's zip from its GitHub release, stopping if it is bigger than listed.
 *
 * @param e - The index entry.
 * @param fetchFn - `fetch` (replaceable in tests).
 * @returns The zip bytes.
 */
export async function downloadRelease(e: StoreEntry, fetchFn: typeof fetch = fetch): Promise<Buffer> {
  const res = await fetchFn(releaseUrl(e), { signal: AbortSignal.timeout(120_000), headers: { "user-agent": "KesherAI" } });
  if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status} for the release of ${e.id} ${e.version}.`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > e.size) throw new Error("The download is bigger than the store index says, so it was stopped.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Verifies and unpacks an entry's zip into a new folder. Nothing is unpacked when the hash differs or a path is unsafe.
 *
 * @param e - The index entry (the allowlist).
 * @param zip - The downloaded zip.
 * @param into - Parent folder for the staging folder.
 * @returns The staging folder and the plugin's manifest (agreeing with the index).
 * @throws On a hash mismatch, an unsafe path, too many or too big files, a missing or disagreeing manifest.
 */
export async function unpackVerified(e: StoreEntry, zip: Uint8Array, into: string): Promise<{ dir: string; manifest: PluginManifest }> {
  verifySha256(zip, e.sha256);
  let bad = "";
  let count = 0;
  let unpacked = 0;
  const files = unzipSync(zip as Uint8Array, {
    filter: (f) => {
      if (f.name.endsWith("/")) return false; // a folder: made when its files are written
      count++;
      unpacked += f.originalSize;
      if (!safeEntryName(f.name)) bad ||= `The zip has an unsafe path: ${JSON.stringify(f.name.slice(0, 80))}.`;
      if (count > MAX_FILES) bad ||= "The zip has too many files.";
      if (unpacked > MAX_UNPACKED) bad ||= "The zip unpacks to more than 150 MB.";
      return !bad;
    },
  });
  if (bad) throw new Error(bad);
  // GitHub-style zips wrap everything in one folder: allow that, never more.
  const names = Object.keys(files);
  let prefix = "";
  if (!names.includes("kesher-plugin.json")) {
    const tops = new Set(names.map((n) => n.split("/")[0]));
    if (tops.size === 1 && names.includes(`${[...tops][0]}/kesher-plugin.json`)) prefix = `${[...tops][0]}/`;
  }
  const manifestBytes = files[`${prefix}kesher-plugin.json`];
  if (!manifestBytes) throw new Error("The zip has no kesher-plugin.json.");
  let manifest: PluginManifest;
  try {
    manifest = PluginManifestSchema.parse(JSON.parse(Buffer.from(manifestBytes).toString("utf8")));
  } catch (err) {
    throw new Error(`kesher-plugin.json in the zip is invalid: ${(err as Error).message}`);
  }
  if (manifest.id !== e.id || manifest.version !== e.version) throw new Error("The plugin's kesher-plugin.json does not match the store index (id or version).");
  const listed = new Set<string>(e.permissions);
  const extra = permissionsOfManifest(manifest).filter((p) => !listed.has(p));
  if (extra.length) throw new Error(`The plugin asks for more than the store lists (${extra.join(", ")}), so it was not installed.`);

  const dir = join(into, `install-${randomUUID()}`);
  const root = resolve(dir);
  try {
    for (const [name, data] of Object.entries(files)) {
      const rel = safeEntryName(name.slice(prefix.length));
      if (!name.startsWith(prefix) || !rel) continue;
      const target = resolve(root, rel);
      if (!target.startsWith(root + sep)) throw new Error("The zip has an unsafe path.");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir, manifest };
}

/**
 * Reads the store index: the first `index.json` found in the plugin roots (it ships with the app), or the one given.
 *
 * @param roots - Plugin root folders; each may hold an `index.json`.
 * @param remote - Optional newer copy fetched from the project's repository; used first when it is valid.
 * @returns The index and where it came from.
 */
export async function loadStoreIndex(roots: string[], remote?: () => Promise<unknown>): Promise<{ index: StoreIndex; source: "remote" | "bundled" | "none" }> {
  if (remote) {
    try {
      return { index: parseStoreIndex(await remote()), source: "remote" };
    } catch {
      // Offline or a bad copy: the one shipped with the app.
    }
  }
  for (const root of roots) {
    try {
      return { index: parseStoreIndex(JSON.parse(await readFile(join(root, "index.json"), "utf8"))), source: "bundled" };
    } catch {
      // Not in this root.
    }
  }
  return { index: { schema: 1, plugins: [] }, source: "none" };
}

/** A phone's request to install a plugin, waiting for the computer's approval. */
export interface InstallRequest {
  id: string;
  /** The store plugin id. */
  pluginId: string;
  /** When it was asked (ms since epoch). */
  at: number;
}

/**
 * Install requests from paired devices. The phone can ask; only the computer approves (the route checks that), so
 * nothing from outside this computer runs without someone pressing a button at the computer.
 * Kept in memory: a request is for now, and expires after an hour.
 */
export class InstallRequests {
  private readonly items = new Map<string, InstallRequest>();
  /** @param now - Clock (replaceable in tests). */
  constructor(private readonly now: () => number = Date.now) {}

  /** Drops requests older than an hour. */
  private prune(): void {
    for (const [k, r] of this.items) if (this.now() - r.at > 3_600_000) this.items.delete(k);
  }

  /**
   * Adds a request (one per plugin: asking again returns the waiting one).
   *
   * @param pluginId - The store plugin id.
   * @returns The request.
   * @throws When too many are waiting.
   */
  create(pluginId: string): InstallRequest {
    this.prune();
    const waiting = [...this.items.values()].find((r) => r.pluginId === pluginId);
    if (waiting) return waiting;
    if (this.items.size >= 20) throw new Error("Too many install requests are waiting at the computer.");
    const r = { id: randomUUID(), pluginId, at: this.now() };
    this.items.set(r.id, r);
    return r;
  }

  /** @returns The waiting requests, oldest first. */
  list(): InstallRequest[] {
    this.prune();
    return [...this.items.values()].sort((a, b) => a.at - b.at);
  }

  /** Removes a request (approved or declined). @returns The request, or `undefined` if it is gone. */
  take(id: string): InstallRequest | undefined {
    this.prune();
    const r = this.items.get(id);
    this.items.delete(id);
    return r;
  }
}
