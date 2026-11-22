/**
 * Files the editors open from the computer or the phone (RESEARCH_LOG "editors open files"): a type allowlist, a size
 * limit, and a chunked upload that lands the file in the chat's `shared/` folder. Nothing here executes anything: a file
 * is only ever stored under a cleaned name with an allowed extension.
 */
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

/** What an allowed extension is for: a kind of media the editors open, or a `part` that belongs beside a model. */
export type UploadKind = "model" | "image" | "audio" | "video" | "part";

/** The extensions the editors take (lower case, no dot). Anything else is refused, whatever its content type says. */
export const EDITOR_UPLOAD_TYPES: Readonly<Record<string, UploadKind>> = {
  glb: "model", gltf: "model", fbx: "model", obj: "model", stl: "model", ply: "model",
  // A model's own companions: glTF's buffers, OBJ's materials.
  bin: "part", mtl: "part",
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", bmp: "image",
  wav: "audio", mp3: "audio", ogg: "audio", opus: "audio", flac: "audio", m4a: "audio", aac: "audio",
  mp4: "video", webm: "video", mov: "video", m4v: "video", mkv: "video",
};

/** The largest file one upload may bring (1 GB). */
export const EDITOR_UPLOAD_MAX = 1024 ** 3;
/** The largest piece one request may carry (16 MB); the page sends 8 MB pieces. */
export const EDITOR_CHUNK_MAX = 16 * 1024 ** 2;
/** The most pieces one file may come in. */
export const EDITOR_CHUNKS_MAX = 256;

/** The answer of {@link checkEditorUpload}. */
export type UploadCheck = { ok: true; name: string; kind: UploadKind } | { ok: false; error: string };

/**
 * A file name made safe to store: no folders, nothing but letters, digits, spaces and `._()-`, at most 120 characters.
 *
 * @param name - The name the page sent.
 * @returns The cleaned name ("file" when nothing is left).
 */
export function cleanUploadName(name: string): string {
  const last = String(name).split(/[\\/]/).pop() ?? "";
  const clean = /^\.+$/.test(last) ? "" : last.replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 120);
  return clean.replace(/^\.+/, "") || "file";
}

/**
 * Whether a file may be uploaded: an allowed extension, not empty, not over {@link EDITOR_UPLOAD_MAX}.
 *
 * @param name - The file's name.
 * @param size - Its size in bytes.
 * @returns The cleaned name and its kind, or the reason in plain words.
 */
export function checkEditorUpload(name: string, size: number): UploadCheck {
  const clean = cleanUploadName(name);
  const kind = EDITOR_UPLOAD_TYPES[(/\.([^.]+)$/.exec(clean)?.[1] ?? "").toLowerCase()];
  if (!kind) return { ok: false, error: "This kind of file cannot be opened in the editors (a model, picture, sound or video)." };
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: "The file is empty." };
  if (size > EDITOR_UPLOAD_MAX) return { ok: false, error: "A file up to 1 GB." };
  return { ok: true, name: clean, kind };
}

/** One piece of a file, as the page sends it. */
export interface UploadPiece {
  /** The chat's folder (the file lands in `shared/` under it). */
  folder: string;
  /** This upload's id: letters, digits and dashes, 8 to 40 of them. */
  id: string;
  /** This piece's place, from 0. */
  index: number;
  /** How many pieces the file comes in. */
  total: number;
  /** The file's name. */
  name: string;
  /** The whole file's size in bytes. */
  size: number;
  /** This piece's bytes. */
  bytes: Buffer;
}

/** What {@link saveUploadPiece} did: waiting for more pieces, or the finished file. */
export type PieceResult = { done: false; received: number } | { done: true; path: string; name: string };

/** Thrown for a piece that is refused; `status` is the HTTP code to answer with. */
export class UploadRefused extends Error {
  /** @param message - Plain words for the page. @param status - The HTTP status. */
  constructor(message: string, readonly status = 400) { super(message); }
}

/**
 * Keeps one piece; when the last one is in, joins them in order into `shared/<name>` (a numbered name when it exists)
 * and checks the joined size is the one announced. Pieces come one after another from one page; a different upload id
 * has its own folder, so two files at once do not mix.
 *
 * @param p - The piece.
 * @returns Waiting (how many pieces are in) or the finished file's path.
 * @throws UploadRefused for a bad name, type, size, id or piece.
 */
export async function saveUploadPiece(p: UploadPiece): Promise<PieceResult> {
  const check = checkEditorUpload(p.name, p.size);
  if (!check.ok) throw new UploadRefused(check.error, 415);
  if (!/^[A-Za-z0-9-]{8,40}$/.test(p.id)) throw new UploadRefused("The upload id is not valid.");
  if (!Number.isInteger(p.total) || p.total < 1 || p.total > EDITOR_CHUNKS_MAX) throw new UploadRefused("Too many pieces.");
  if (!Number.isInteger(p.index) || p.index < 0 || p.index >= p.total) throw new UploadRefused("This piece's place is not valid.");
  if (!p.bytes.length) throw new UploadRefused("An empty piece.");
  if (p.bytes.length > EDITOR_CHUNK_MAX) throw new UploadRefused("A piece up to 16 MB.", 413);
  const tmp = join(p.folder, ".upload-tmp", p.id);
  await mkdir(tmp, { recursive: true });
  await pipeline(Readable.from(p.bytes), createWriteStream(join(tmp, `${String(p.index).padStart(4, "0")}.part`)));
  const have = (await readdir(tmp)).filter((f) => f.endsWith(".part")).sort();
  if (have.length < p.total) return { done: false, received: have.length };
  const dir = join(p.folder, "shared");
  await mkdir(dir, { recursive: true });
  let path = join(dir, check.name);
  for (let i = 2; existsSync(path); i++) path = join(dir, check.name.replace(/(\.[^.]*)?$/, ` (${i})$1`));
  try {
    const out = createWriteStream(path);
    for (const f of have) {
      const buf = await readFile(join(tmp, f));
      if (!out.write(buf)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((resolve, reject) => { out.once("error", reject); out.end(resolve); });
    if ((await stat(path)).size !== p.size) { await rm(path, { force: true }); throw new UploadRefused("The pieces do not add up to the file's size."); }
  } finally { await rm(tmp, { recursive: true, force: true }); }
  return { done: true, path, name: basename(path) };
}
