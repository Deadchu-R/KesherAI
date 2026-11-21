/**
 * Importing chats from another app in two steps, from the computer or the phone: the export file is sent to this
 * computer in a stream and kept in KesherAI's data folder ({@link ImportSessions.receive}); a preview lists its
 * chats (counts, dates, which are already here) and the instructions it holds ({@link ImportSessions.preview});
 * then the chats the user picked are saved ({@link ImportSessions.commit}) and the file is deleted.
 *
 * The file is read twice in a stream (once for the preview, once to save), never held whole. Pictures in a zip are
 * unpacked only for the chats picked. Nothing leaves this computer.
 */

import { createWriteStream, existsSync, closeSync, openSync, writeSync } from "node:fs";
import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ExportReader, importedChatId, NOT_AN_EXPORT, type ExportPersona, type GeminiSplit, type ImportedChat, type ImportedFile, type ImportSource } from "./chat-import.js";
import { scanImportFile } from "./import-stream.js";

/** One chat in the preview. */
export interface ChatPreview {
  /** The chat's id in the other app (what the page sends back to pick it). */
  key: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: number;
  /** Other branches of it (edited messages, other answers). */
  branches: number;
  /** Pictures and files in it. */
  files: number;
  /** Already imported (importing again skips it). */
  have: boolean;
}

/** What an uploaded export holds. */
export interface ImportPreview {
  token: string;
  fileName: string;
  source: ImportSource;
  chats: ChatPreview[];
  /** Instructions found (custom instructions, Claude projects, chat prompts), to add as personas. */
  personas: Array<ExportPersona & { have: boolean }>;
  /** The oldest and newest chat. */
  from?: string;
  to?: string;
  /** Items that could not be read. */
  broken: number;
  geminiSplit: GeminiSplit;
}

/** What {@link ImportSessions.commit} needs from the rest of KesherAI. */
export interface CommitTarget {
  /**
   * Saves chats (a chat's branches come after it).
   *
   * @param media - The unpacked file for a picture a chat points to, when the zip had it.
   */
  saveChats: (chats: ImportedChat[], media: (f: ImportedFile) => string | undefined) => Promise<{ added: number; skipped: number }>;
  /** Saves one persona, unless the same instructions are there already. Returns whether it was added. */
  savePersona: (p: ExportPersona) => Promise<boolean>;
}

interface Upload { path: string; fileName: string; at: number; preview?: ImportPreview; wanted?: Map<string, string[]> }

/** How long an upload nobody imported is kept. */
const KEEP_MS = 6 * 60 * 60 * 1000;
/** The disk space left free while an upload is written. */
const MIN_FREE = 2 * 1024 ** 3;
/** The biggest export accepted. */
const MAX_UPLOAD = 20 * 1024 ** 3;

/** The zip entry that holds a picture a chat points to, from the entries' names. */
export function mediaIndex(entries: string[]): (f: ImportedFile) => string | undefined {
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const e of entries) {
    const base = e.replace(/^.*\//, "");
    // ChatGPT: `file-Ab12-photo.png`, `file_0000abc-….png`, `dalle-generations/file-….webp`, `<chat>/image/file_….png`.
    const id = /^(file[-_][A-Za-z0-9]+)/.exec(base)?.[1];
    if (id && !byId.has(id)) byId.set(id, e);
    if (!byName.has(base) || /gemini|bard/i.test(e)) byName.set(base, e);
  }
  return (f) => {
    if (!f.ref) return undefined;
    if (f.ref.startsWith("gemini:")) return byName.get(f.ref.slice(7));
    return byId.get(f.ref.replace(/^[a-z-]+:\/\//i, ""));
  };
}

/** Uploaded exports waiting to be previewed and imported. */
export class ImportSessions {
  private readonly uploads = new Map<string, Upload>();

  /**
   * @param dir - Where uploads are kept (inside KesherAI's data folder).
   * @param exists - Whether a chat with this KesherAI id is here already.
   * @param personaHave - Whether a persona with these instructions is here already.
   */
  constructor(private readonly dir: string, private readonly exists: (id: string) => boolean, private readonly personaHave: (instructions: string) => boolean = () => false) {}

  /**
   * Writes an uploaded export to disk as it comes (no size kept in memory). Uploads older than six hours are
   * removed first.
   *
   * @param body - The file's bytes.
   * @param fileName - Its name (shown in the preview only).
   * @returns The upload's token.
   */
  async receive(body: AsyncIterable<Buffer | Uint8Array>, fileName: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    await this.sweep();
    const token = randomUUID();
    const path = join(this.dir, `${token}.upload`);
    const out = createWriteStream(path);
    let bytes = 0;
    let checked = 0;
    try {
      for await (const chunk of body) {
        bytes += chunk.length;
        if (bytes > MAX_UPLOAD) throw Object.assign(new Error("The file is too big (over 20 GB)."), { statusCode: 413 });
        if (bytes - checked > 64 * 1024 ** 2) {
          checked = bytes;
          const f = await statfs(this.dir).catch(() => undefined);
          if (f && Number(f.bavail) * Number(f.bsize) < MIN_FREE) throw Object.assign(new Error("The disk is almost full: free some space and try again."), { statusCode: 507 });
        }
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
    } catch (err) {
      out.destroy();
      await rm(path, { force: true });
      throw err;
    } finally {
      await new Promise<void>((done) => (out.closed ? done() : out.end(() => done())));
    }
    if (!bytes) {
      await rm(path, { force: true });
      throw Object.assign(new Error("The file is empty."), { statusCode: 400 });
    }
    this.uploads.set(token, { path, fileName: fileName.replace(/^.*[\\/]/, "").slice(0, 200) || "export", at: Date.now() });
    return token;
  }

  /** Removes uploads (and their unpacked pictures) older than {@link KEEP_MS}. */
  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [t, u] of this.uploads) if (now - u.at > KEEP_MS) await this.discard(t);
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const p = join(this.dir, name);
      const st = await stat(p).catch(() => undefined);
      if (st && now - st.mtimeMs > KEEP_MS) await rm(p, { recursive: true, force: true });
    }
  }

  /**
   * Reads an upload and lists what it holds.
   *
   * @param token - From {@link receive}.
   * @param geminiSplit - How Gemini prompts with no chat id are grouped.
   * @returns The preview.
   * @throws Error when the token is unknown or the file is no known export.
   */
  async preview(token: string, geminiSplit: GeminiSplit = "day"): Promise<ImportPreview> {
    const u = this.uploads.get(token);
    if (!u || !existsSync(u.path)) throw Object.assign(new Error("That upload is gone: choose the file again."), { statusCode: 404 });
    const chats = new Map<string, ChatPreview>();
    const refs = new Map<string, ImportedFile[]>();
    const reader = new ExportReader((c) => {
      const key = c.root ?? c.originalId;
      const files = c.messages.flatMap((m) => m.files ?? []);
      if (files.some((f) => f.ref)) refs.set(key, [...(refs.get(key) ?? []), ...files.filter((f) => f.ref)]);
      const p = chats.get(key);
      if (p) {
        if (c.root) p.branches++;
        return;
      }
      chats.set(key, { key, title: c.title.slice(0, 120), createdAt: c.createdAt, updatedAt: c.messages.at(-1)?.at ?? c.createdAt, messages: c.messages.length, branches: 0, files: files.length, have: this.exists(importedChatId(c.source, c.originalId)) });
    }, geminiSplit);
    const scan = await scanImportFile(u.path, reader);
    if (!reader.source && !reader.personas.length) throw Object.assign(new Error(NOT_AN_EXPORT), { statusCode: 400 });
    // Which zip entries each chat needs (only those are unpacked when it is imported).
    const find = mediaIndex(scan.entries);
    u.wanted = new Map([...refs].map(([k, fs]) => [k, [...new Set(fs.map(find).filter((x): x is string => !!x))]]));
    const list = [...chats.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    const times = list.map((c) => c.createdAt).filter((t) => !t.startsWith("1970")).sort();
    u.preview = {
      token,
      fileName: u.fileName,
      source: reader.source ?? "claude",
      chats: list,
      personas: reader.personas.map((p) => ({ ...p, have: this.personaHave(p.instructions) })),
      ...(times.length ? { from: times[0], to: list.reduce((m, c) => (c.updatedAt > m ? c.updatedAt : m), times.at(-1)!) } : {}),
      broken: scan.broken,
      geminiSplit,
    };
    return u.preview;
  }

  /** The newest preview not yet imported (the page was closed or the phone switched apps while it was open). */
  pending(): ImportPreview | undefined {
    return [...this.uploads.values()].filter((u) => u.preview).sort((a, b) => b.at - a.at)[0]?.preview;
  }

  /**
   * Saves the chats picked from an upload, then deletes the upload.
   *
   * @param token - From {@link receive}.
   * @param pick - The chats' keys (all when undefined) and the personas' indexes in the preview.
   * @param target - Where chats and personas are saved.
   * @returns How many chats were added and skipped, and how many personas were added.
   */
  async commit(token: string, pick: { keys?: string[]; personas?: number[] }, target: CommitTarget): Promise<{ source: ImportSource; added: number; skipped: number; personas: number }> {
    const u = this.uploads.get(token);
    const preview = u?.preview;
    if (!u || !preview || !existsSync(u.path)) throw Object.assign(new Error("That upload is gone: choose the file again."), { statusCode: 404 });
    const keys = pick.keys ? new Set(pick.keys) : undefined;
    const take = (key: string) => !keys || keys.has(key);
    const mediaDir = join(this.dir, `${token}-media`);
    const unpacked = new Map<string, string>();
    try {
      // Pass 1 (a zip with pictures for the chats picked): unpack only those entries.
      const wanted = new Set([...(u.wanted ?? [])].filter(([k]) => take(k)).flatMap(([, v]) => v));
      if (wanted.size) {
        await mkdir(mediaDir, { recursive: true });
        await scanImportFile(u.path, new ExportReader(() => undefined), {
          mediaOnly: true,
          media: (name) => {
            if (!wanted.has(name)) return undefined;
            const path = join(mediaDir, `${unpacked.size}-${name.replace(/^.*\//, "").replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 120)}`);
            const fd = openSync(path, "w");
            unpacked.set(name, path);
            return (data, final) => {
              if (data.length) writeSync(fd, data);
              if (final) closeSync(fd);
            };
          },
        });
      }
      const find = mediaIndex([...unpacked.keys()]);
      const media = (f: ImportedFile) => {
        const entry = find(f);
        return entry ? unpacked.get(entry) : undefined;
      };
      // Pass 2: the chats, saved as they are read.
      let batch: ImportedChat[] = [];
      let added = 0;
      let skipped = 0;
      const flush = async () => {
        if (!batch.length) return;
        const now = batch;
        batch = [];
        const r = await target.saveChats(now, media);
        added += r.added;
        skipped += r.skipped;
      };
      await scanImportFile(u.path, new ExportReader((c) => void (take(c.root ?? c.originalId) && batch.push(c)), preview.geminiSplit), { afterChunk: flush });
      await flush();
      let personas = 0;
      for (const i of pick.personas ?? []) {
        const p = preview.personas[i];
        if (p && (await target.savePersona(p))) personas++;
      }
      await this.discard(token);
      return { source: preview.source, added, skipped, personas };
    } finally {
      await rm(mediaDir, { recursive: true, force: true });
    }
  }

  /**
   * Deletes an upload without importing it.
   *
   * @param token - From {@link receive}.
   */
  async discard(token: string): Promise<void> {
    const u = this.uploads.get(token);
    this.uploads.delete(token);
    if (u) await rm(u.path, { force: true });
    await rm(join(this.dir, `${token}-media`), { recursive: true, force: true });
  }
}
