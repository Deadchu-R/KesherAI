import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type { AssetStore } from "./assets.js";

/**
 * The bank of everything the AI made (docs/RESEARCH_LOG.md "Adding files and objects to the editors, and one bank
 * of everything the AI made"): the generated assets, and the pictures, videos, sounds and 3D models in every chat's
 * folder, in one list, to find, take into another chat, delete, and find duplicates in.
 */

/** What a bank item is, for the filters and the editors. */
export type BankKind = "image" | "video" | "audio" | "model";

/** One file in the bank. */
export interface BankItem {
  /** `a.<asset id>` (a generated asset) or `f.<chat id>.<path in base64url>` (a file in a chat's folder). */
  id: string;
  kind: BankKind;
  name: string;
  size: number;
  /** When it was made (the file's time for a chat's file). */
  createdAt: string;
  /** The chat it is in, when it is a chat's file. */
  chat?: { id: string; title: string };
  /** The words it was made from, when known. */
  prompt?: string;
  /** The model that made it, when known. */
  model?: string;
}

/** A set of items that are the same file (`same`) or, for pictures, look the same (`looks`, found in the page). */
export interface DuplicateGroup {
  hash: string;
  /** Oldest first: the first is the one to keep. */
  items: string[];
  /** The bytes deleting the others would free. */
  bytes: number;
}

const KINDS: Array<[BankKind, RegExp]> = [
  ["image", /\.(png|jpe?g|webp|gif|bmp)$/i],
  ["video", /\.(mp4|webm|mov|m4v|mkv)$/i],
  ["audio", /\.(mp3|wav|m4a|flac|ogg|opus|aac)$/i],
  ["model", /\.(glb|gltf|fbx|obj|stl)$/i],
];
/** Folders in a chat's folder that are not things it made. */
const SKIP = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", ".cache"]);
/** At most this many files are walked per chat, and in all. */
const PER_CHAT = 400;
const MAX_ITEMS = 5000;

/**
 * What kind of media a file name is.
 *
 * @param name - File name.
 * @returns Its kind, or undefined when it is not a picture, video, sound or 3D model.
 */
export function bankKindOf(name: string): BankKind | undefined {
  return KINDS.find(([, re]) => re.test(name))?.[0];
}

/** A chat the bank reads (the summary the library lists). */
export interface BankChat {
  id: string;
  title: string;
  kind?: string;
}

/** What the bank needs from the services. */
export interface BankDeps {
  assets: AssetStore;
  /** The chats (code sessions are left out: their folder is a project, not things the AI made). */
  chats: () => BankChat[];
  /** A chat's folder. */
  folderOf: (chat: BankChat) => string | undefined;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

/**
 * The bank: lists, reads, copies, deletes and finds duplicates. Ids are checked strictly; a chat's file is always
 * resolved inside that chat's folder.
 */
export class AssetBank {
  /** SHA-256 of a file, kept while its size and time stay the same. */
  private readonly hashes = new Map<string, string>();

  /** @param deps - The asset store and the chats. */
  constructor(private readonly deps: BankDeps) {}

  /**
   * Every item, newest first.
   *
   * @param kind - Only this kind, when given.
   * @returns The items (at most 5000).
   */
  async list(kind?: BankKind): Promise<BankItem[]> {
    const out: BankItem[] = [];
    for (const a of await this.deps.assets.list()) {
      const k: BankKind | undefined = a.mimeType.startsWith("model/") ? "model" : (["image", "video", "audio"] as const).find((x) => a.mimeType.startsWith(x));
      if (!k || (kind && k !== kind)) continue;
      const meta = (a.meta ?? {}) as { prompt?: unknown; use?: unknown };
      const prompt = typeof meta.prompt === "string" ? meta.prompt : undefined;
      const ext = a.mimeType.split("/")[1]?.replace("jpeg", "jpg").replace("gltf-binary", "glb").replace("mpeg", "mp3") ?? "bin";
      out.push({ id: `a.${a.id}`, kind: k, name: `${(prompt ?? (typeof meta.use === "string" ? meta.use : k)).slice(0, 60)}.${ext}`, size: a.size, createdAt: a.createdAt, ...(prompt ? { prompt } : {}), ...(a.sourceModelId ? { model: a.sourceModelId } : {}) });
    }
    for (const c of this.deps.chats()) {
      if (c.kind === "code" || out.length >= MAX_ITEMS) continue;
      const root = this.deps.folderOf(c);
      if (!root) continue;
      for (const f of await walk(root, PER_CHAT)) {
        const k = bankKindOf(f.path);
        if (!k || (kind && k !== kind)) continue;
        out.push({ id: `f.${c.id}.${b64(f.path)}`, kind: k, name: basename(f.path), size: f.size, createdAt: f.at, chat: { id: c.id, title: c.title } });
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_ITEMS);
  }

  /**
   * Where an item's file is on the disk.
   *
   * @param id - A bank id.
   * @returns The file's path and name, or undefined when the id is not a known item.
   */
  async pathOf(id: string): Promise<{ path: string; name: string } | undefined> {
    const a = /^a\.([0-9a-f-]{36})$/.exec(id);
    if (a) {
      const found = await this.deps.assets.recordOf(a[1]!);
      if (!found) return undefined;
      const file = this.deps.assets.fileOf(found);
      const meta = (found.meta ?? {}) as { prompt?: unknown };
      const stem = typeof meta.prompt === "string" ? meta.prompt.slice(0, 40) : found.id.slice(0, 8);
      return (await stat(file).catch(() => undefined))?.isFile() ? { path: file, name: `${stem}${extname(file)}` } : undefined;
    }
    const f = /^f\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{1,2000})$/.exec(id);
    if (!f) return undefined;
    const chat = this.deps.chats().find((c) => c.id === f[1]);
    const root = chat && chat.kind !== "code" ? this.deps.folderOf(chat) : undefined;
    if (!root) return undefined;
    const rel = unb64(f[2]!);
    // Inside the chat's folder only, and only a media file.
    if (!bankKindOf(rel) || rel.split(/[\\/]/).some((p) => p === ".." || p === "") || /^[a-z]:/i.test(rel)) return undefined;
    const full = join(root, rel);
    if (relative(root, full).startsWith("..")) return undefined;
    const st = await stat(full).catch(() => undefined);
    return st?.isFile() ? { path: full, name: basename(full) } : undefined;
  }

  /**
   * Copies items into a chat's folder (`shared/`), so that chat owns them (an editor adds them from there).
   *
   * @param ids - Bank ids.
   * @param chatId - The chat to copy into.
   * @returns The copied files' paths in that chat's folder.
   */
  async copyTo(ids: string[], chatId: string): Promise<string[]> {
    const chat = this.deps.chats().find((c) => c.id === chatId);
    const root = chat ? this.deps.folderOf(chat) : undefined;
    if (!root) throw new Error("Chat not found");
    const dir = join(root, "shared");
    await mkdir(dir, { recursive: true });
    const out: string[] = [];
    for (const id of ids.slice(0, 50)) {
      const from = await this.pathOf(id);
      if (!from) continue;
      // The same file already in this chat stays where it is.
      if (from.path.startsWith(root + sep)) {
        out.push(relative(root, from.path).split(sep).join("/"));
        continue;
      }
      const ext = extname(from.name);
      const stem = basename(from.name, ext).replace(/[^\p{L}\p{N} ._-]+/gu, "-").slice(0, 80) || "file";
      let name = `${stem}${ext}`;
      for (let i = 2; await stat(join(dir, name)).then(() => true, () => false); i++) name = `${stem}-${i}${ext}`;
      await copyFile(from.path, join(dir, name));
      out.push(`shared/${name}`);
    }
    return out;
  }

  /**
   * Deletes items for good (a generated asset also disappears from the chats that show it).
   *
   * @param ids - Bank ids.
   * @returns How many were deleted.
   */
  async delete(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids.slice(0, 500)) {
      const a = /^a\.([0-9a-f-]{36})$/.exec(id);
      if (a) {
        if (await this.deps.assets.delete(a[1]!)) n++;
        continue;
      }
      const found = await this.pathOf(id);
      if (!found) continue;
      await rm(found.path, { force: true });
      n++;
    }
    return n;
  }

  /**
   * The files that are the same bytes. Only files of the same size are read (most have no twin), each once while
   * it does not change.
   *
   * @returns The groups, the most bytes to free first.
   */
  async duplicates(): Promise<DuplicateGroup[]> {
    const items = await this.list();
    const bySize = new Map<number, BankItem[]>();
    for (const it of items) if (it.size > 0) bySize.set(it.size, [...(bySize.get(it.size) ?? []), it]);
    const byHash = new Map<string, BankItem[]>();
    for (const same of bySize.values()) {
      if (same.length < 2) continue;
      for (const it of same) {
        const p = await this.pathOf(it.id);
        if (!p) continue;
        const key = `${p.path}|${it.size}|${it.createdAt}`;
        let h = this.hashes.get(key);
        if (!h) {
          h = await sha256(p.path);
          this.hashes.set(key, h);
        }
        byHash.set(h, [...(byHash.get(h) ?? []), it]);
      }
    }
    return [...byHash.entries()]
      .filter(([, g]) => g.length > 1)
      .map(([hash, g]) => {
        const sorted = [...g].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return { hash, items: sorted.map((x) => x.id), bytes: sorted.slice(1).reduce((t, x) => t + x.size, 0) };
      })
      .sort((a, b) => b.bytes - a.bytes);
  }
}

/** The files under a folder (skipping caches), with size and time. */
async function walk(root: string, max: number): Promise<Array<{ path: string; size: number; at: string }>> {
  const out: Array<{ path: string; size: number; at: string }> = [];
  const go = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (out.length >= max) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await go(full);
      } else if (e.isFile() && bankKindOf(e.name)) {
        const st = await stat(full).catch(() => undefined);
        if (st) out.push({ path: relative(root, full).split(sep).join("/"), size: st.size, at: st.mtime.toISOString() });
      }
    }
  };
  await go(root);
  return out;
}

/** The SHA-256 of a file, read as a stream. */
function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}
