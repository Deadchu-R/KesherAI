import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { insideProject, realInside, type GameCheckpoints } from "./game-checkpoints.js";
import { unrealAssetInfo } from "./unreal-assets.js";

/**
 * "Open from project" in the editors (WORK_LIST "Editors pull assets from Unity and Unreal projects", Roee 2026-11-22):
 * a found Unity or Unreal project's assets listed by the kinds an editor takes, opened with the engine closed, and saved
 * back with the computer's approval.
 *
 * - Unity: the files under Assets/ are read as they are (TGA and PSD turned into PNG by flat-image.ts; a prefab is put
 *   together from its meshes by the scene stand-in's reader). Saving writes the file in place (a checkpoint copy first)
 *   or a new file next to it; Unity reimports it when it gets focus. .meta files and materials are never touched.
 * - Unreal: .uasset files are binary, so the KesherAI Bridge plugin (0.1.33+) exports them (meshes as FBX, textures as
 *   PNG, sounds as WAV) in the open editor or a headless one; the exports are kept by asset path, file time and size.
 *   Saving imports the edited file over the asset (or next to it) through the plugin, after a checkpoint of the .uasset.
 *
 * Every path is checked to be inside a found project (no "..", no links out, only Assets/ or Content/), and every save is
 * staged first and written only when approved on the computer itself (never from the phone alone).
 */

/** The kinds of asset the editors take. */
export type AssetKind = "model" | "image" | "audio" | "video";
/** The engines this works with. */
export type AssetEngine = "unity" | "unreal";
export const ASSET_KINDS: readonly AssetKind[] = ["model", "image", "audio", "video"];

/** Unity files by kind (a prefab is a model put together from its meshes). .blend is left out (it needs Blender). */
export const UNITY_EXT: Record<AssetKind, RegExp> = {
  model: /\.(fbx|obj|gltf|glb|prefab)$/i,
  image: /\.(png|jpe?g|tga|psd)$/i,
  audio: /\.(wav|mp3|ogg)$/i,
  video: /\.(mp4|webm|mov)$/i,
};

/** Unreal asset classes by kind (what the plugin can export), and the raw movie files Unreal keeps under Content/. */
export const UNREAL_CLASS: Record<AssetKind, readonly string[]> = { model: ["StaticMesh", "SkeletalMesh"], image: ["Texture2D"], audio: ["SoundWave"], video: [] };
const UNREAL_RAW_VIDEO = /\.(mp4|webm|mov)$/i;

/** The plugin version that can export and import assets. */
export const EXPORT_PLUGIN = "0.1.33";

/** The most files listed, folders looked at, and time spent per listing. */
const MAX_ITEMS = 3000;
const MAX_FOLDERS = 20_000;
const LIST_MS = 8000;
/** Pictures up to this size are shown as their own thumbnail. */
const THUMB_BYTES = 2 * 1024 * 1024;
/** The biggest file opened in an editor, and the biggest save. */
export const MAX_OPEN = 512 * 1024 * 1024;
export const MAX_SAVE = 300 * 1024 * 1024;

/** One asset in the browser. */
export interface ProjectAsset {
  /** Relative to the project, with "/" (Assets/… or Content/…). */
  path: string;
  name: string;
  kind: AssetKind;
  size: number;
  mtime: number;
  /** The file's extension, lower case. */
  ext: string;
  /** Unreal: the asset's class (StaticMesh, Texture2D…). */
  className?: string;
  /** Unity: put together from a prefab's meshes. */
  prefab?: true;
  /** A picture small enough to be its own thumbnail. */
  thumb?: true;
  /** Unreal: opened through the plugin (an export). */
  export?: ExportFormat;
}

/** What the plugin exports each class as. */
export type ExportFormat = "fbx" | "png" | "wav";

/**
 * The format the plugin exports an Unreal class as.
 *
 * @param className - The asset's class.
 * @returns fbx, png or wav; undefined for a class the editors cannot open.
 */
export function exportFormat(className: string | undefined): ExportFormat | undefined {
  if (className === "StaticMesh" || className === "SkeletalMesh") return "fbx";
  if (className === "Texture2D") return "png";
  if (className === "SoundWave") return "wav";
  return undefined;
}

/**
 * Which kind a Unity file is.
 *
 * @param rel - Its path.
 * @returns The kind, or undefined for a file the editors do not take.
 */
export function unityKind(rel: string): AssetKind | undefined {
  return ASSET_KINDS.find((k) => UNITY_EXT[k].test(rel));
}

/**
 * Whether a plugin version can export (0.1.33 or newer).
 *
 * @param version - The project's plugin VersionName ("0.1.32"), or undefined.
 */
export function pluginCanExport(version: string | undefined): boolean {
  if (!version) return false;
  const a = version.split(".").map(Number), b = EXPORT_PLUGIN.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/**
 * The KesherAI Bridge plugin's version in an Unreal project.
 *
 * @param dir - The project folder.
 * @returns Its VersionName, or undefined when the plugin is not there.
 */
export async function projectPluginVersion(dir: string): Promise<string | undefined> {
  try {
    const j = JSON.parse((await readFile(join(dir, "Plugins", "KesherAIBridge", "KesherAIBridge.uplugin"), "utf8")).replace(/^\uFEFF/, "")) as { VersionName?: unknown };
    return typeof j.VersionName === "string" ? j.VersionName : undefined;
  } catch {
    return undefined;
  }
}

/** Folders never walked: hidden ones, Unity's "~" folders, Unreal's one-file-per-actor and developer folders. */
const SKIP_DIR = /^(\.|__ExternalActors__$|__ExternalObjects__$|Collections$|Developers$)|~$/;

/**
 * Walks a folder breadth first (names only), within limits.
 *
 * @param root - The folder.
 * @param keep - Whether a file is wanted (by its name).
 * @param until - When to stop (a Date.now() time).
 * @returns The wanted files (absolute) and whether it stopped early.
 */
async function walk(root: string, keep: (name: string) => boolean, until: number): Promise<{ files: string[]; partial: boolean }> {
  const files: string[] = [];
  let queue = [root];
  let folders = 0;
  while (queue.length) {
    const next: string[] = [];
    for (const dir of queue) {
      if (++folders > MAX_FOLDERS || files.length >= MAX_ITEMS * 4 || Date.now() > until) return { files, partial: true };
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) next.push(join(dir, e.name)); }
        else if (e.isFile() && keep(e.name)) files.push(join(dir, e.name));
      }
    }
    queue = next;
  }
  return { files, partial: false };
}

const relOf = (dir: string, abs: string) => abs.slice(dir.length + 1).split(/[\\/]/).join("/");
const extOf = (rel: string) => posix.extname(rel).slice(1).toLowerCase();
const nameOf = (rel: string) => posix.basename(rel).replace(/\.[^.]+$/, "");

/**
 * A Unity project's assets of some kinds, under Assets/.
 *
 * @param dir - The project folder.
 * @param kinds - The kinds wanted.
 * @param budgetMs - The time allowed.
 * @returns The assets (sorted by path, at most 3000) and whether the list stopped early.
 */
export async function listUnityAssets(dir: string, kinds: readonly AssetKind[], budgetMs = LIST_MS): Promise<{ items: ProjectAsset[]; partial: boolean }> {
  const want = (n: string) => kinds.some((k) => UNITY_EXT[k].test(n));
  const { files, partial } = await walk(join(dir, "Assets"), want, Date.now() + budgetMs);
  const items: ProjectAsset[] = [];
  for (const abs of files.slice(0, MAX_ITEMS)) {
    const st = await stat(abs).catch(() => undefined);
    if (!st?.isFile()) continue;
    const path = relOf(dir, abs);
    const kind = kinds.find((k) => UNITY_EXT[k].test(path))!;
    const ext = extOf(path);
    items.push({ path, name: nameOf(path), kind, size: st.size, mtime: st.mtimeMs, ext, ...(ext === "prefab" ? { prefab: true as const } : {}), ...(kind === "image" && /^(png|jpe?g)$/.test(ext) && st.size <= THUMB_BYTES ? { thumb: true as const } : {}) });
  }
  return { items: items.sort((a, b) => a.path.localeCompare(b.path)), partial: partial || files.length > MAX_ITEMS };
}

/**
 * An Unreal project's assets of some kinds, under Content/: packages by the class in their header (no Unreal needed),
 * and raw movie files.
 *
 * @param dir - The project folder.
 * @param kinds - The kinds wanted.
 * @param budgetMs - The time allowed.
 * @returns The assets (sorted by path, at most 3000) and whether the list stopped early.
 */
export async function listUnrealAssets(dir: string, kinds: readonly AssetKind[], budgetMs = LIST_MS): Promise<{ items: ProjectAsset[]; partial: boolean }> {
  const until = Date.now() + budgetMs;
  const video = kinds.includes("video");
  const { files, partial } = await walk(join(dir, "Content"), (n) => /\.uasset$/i.test(n) || (video && UNREAL_RAW_VIDEO.test(n)), until);
  const items: ProjectAsset[] = [];
  let late = partial;
  for (const abs of files) {
    if (items.length >= MAX_ITEMS) { late = true; break; }
    if (Date.now() > until) { late = true; break; }
    const path = relOf(dir, abs);
    const st = await stat(abs).catch(() => undefined);
    if (!st?.isFile()) continue;
    if (UNREAL_RAW_VIDEO.test(path)) {
      items.push({ path, name: nameOf(path), kind: "video", size: st.size, mtime: st.mtimeMs, ext: extOf(path) });
      continue;
    }
    const info = await unrealAssetInfo(abs);
    const kind = kinds.find((k) => info?.className && UNREAL_CLASS[k].includes(info.className));
    const format = exportFormat(info?.className);
    if (!kind || !format) continue;
    items.push({ path, name: nameOf(path), kind, size: st.size, mtime: st.mtimeMs, ext: "uasset", className: info!.className!, export: format });
  }
  return { items: items.sort((a, b) => a.path.localeCompare(b.path)), partial: late };
}

/**
 * A path an editor asks for, checked: relative, no "..", under Assets/ (Unity) or Content/ (Unreal), a type that engine's
 * browser lists, inside the project with links followed.
 *
 * @param engine - The project's engine.
 * @param project - The project folder (one found on this computer).
 * @param path - The asked path.
 * @param shader - Also allow a Unity Shader Graph (only a save's target, made by {@link planSave}).
 * @returns The full path and the clean relative one.
 * @throws With statusCode 400 for anything else.
 */
export async function safeAssetPath(engine: AssetEngine, project: string, path: unknown, shader = false): Promise<{ abs: string; rel: string }> {
  const bad = (why: string) => Object.assign(new Error(why), { statusCode: 400 });
  const rel = String(path ?? "").replace(/\\/g, "/");
  if (!rel || rel.length > 600 || rel.includes("\0") || /^([a-z]:|\/)/i.test(rel) || rel.split("/").some((p) => p === ".." || p === "." || p === "")) throw bad("Give a path inside the project.");
  const allowed = engine === "unity" ? /^Assets\//.test(rel) && (!!unityKind(rel) || (shader && /\.shadergraph$/i.test(rel))) : /^Content\//.test(rel) && (/\.uasset$/i.test(rel) || UNREAL_RAW_VIDEO.test(rel));
  if (!allowed) throw bad(engine === "unity" ? "A model, picture, sound or video under Assets/." : "A mesh, texture, sound or movie under Content/.");
  let p: { abs: string; rel: string };
  try {
    p = insideProject(project, rel);
    await realInside(project, p.abs);
  } catch (e) {
    throw bad((e as Error).message);
  }
  return p;
}

/**
 * The key an Unreal export is kept by: the project, the asset's path, its file's time and size (a change in Unreal
 * gives a new key, so an old export is never shown), and the export format.
 *
 * @param project - The project folder.
 * @param rel - The asset's path in the project.
 * @param mtimeMs - The .uasset's modification time.
 * @param size - Its size.
 * @param format - What it is exported as.
 * @returns A file-name-safe key.
 */
export function exportKey(project: string, rel: string, mtimeMs: number, size: number, format: ExportFormat): string {
  return createHash("sha256").update(`${project.toLowerCase()}\n${rel}\n${Math.floor(mtimeMs)}\n${size}\n${format}`).digest("hex").slice(0, 40);
}

/**
 * The /Game package of a Content/ file (Content/Props/SM_Rock.uasset → /Game/Props/SM_Rock).
 *
 * @param rel - The path in the project.
 */
export function gamePackage(rel: string): string {
  return `/Game/${rel.replace(/^Content\//, "").replace(/\.uasset$/i, "")}`;
}

/** Runs a plugin command on a project's .uproject (the live editor or a headless one). */
export type UnrealRunner = (projectFile: string, cmd: "asset_export" | "asset_import", args: Record<string, unknown>) => Promise<unknown>;

/** An Unreal package's class, from its file. */
export type ClassOf = (abs: string) => Promise<string | undefined>;
const headerClass: ClassOf = async (abs) => (await unrealAssetInfo(abs))?.className;

/** Exports in progress by key (two editors asking for the same asset wait for one export). */
const exporting = new Map<string, Promise<string>>();

/**
 * An Unreal asset's export, from the kept copy when its key matches, else made now by the plugin (into the project's
 * Saved/KesherAI/exports, then moved into the cache).
 *
 * @param o.cacheDir - Where exports are kept.
 * @param o.project - The project folder.
 * @param o.projectFile - Its .uproject.
 * @param o.rel - The asset (Content/….uasset).
 * @param o.run - Runs the plugin command.
 * @param o.classOf - The asset's class (default: from its header; tests give their own).
 * @returns The kept export's path and its format.
 */
export async function unrealExport(o: { cacheDir: string; project: string; projectFile: string; rel: string; run: UnrealRunner; classOf?: ClassOf }): Promise<{ file: string; format: ExportFormat; cached: boolean }> {
  const abs = join(o.project, o.rel);
  const st = await stat(abs);
  const format = exportFormat(await (o.classOf ?? headerClass)(abs));
  if (!format) throw Object.assign(new Error("Only meshes, textures and sounds open in the editors."), { statusCode: 415 });
  const key = exportKey(o.project, o.rel, st.mtimeMs, st.size, format);
  const file = join(o.cacheDir, `${key}.${format}`);
  if (existsSync(file)) return { file, format, cached: true };
  let job = exporting.get(key);
  if (!job) {
    job = (async () => {
      const out = join(o.project, "Saved", "KesherAI", "exports", `${key}.${format}`);
      await mkdir(dirname(out), { recursive: true });
      await o.run(o.projectFile, "asset_export", { path: gamePackage(o.rel), file: out });
      if (!existsSync(out)) throw new Error("Unreal did not write the export.");
      await mkdir(o.cacheDir, { recursive: true });
      await copyFile(out, `${file}.tmp`);
      await rename(`${file}.tmp`, file);
      await rm(out, { force: true });
      return file;
    })().finally(() => exporting.delete(key));
    exporting.set(key, job);
  }
  return { file: await job, format, cached: false };
}

/** What an editor saves: the formats the editors write. */
export type SaveFormat = "glb" | "png" | "wav" | "shadergraph";

/**
 * What a file's first bytes say it is.
 *
 * @param head - The first 12+ bytes (32 for a Shader Graph).
 * @returns glb, png, wav or shadergraph (the 3D editor's material graph export: Unity's JSON, starting with its version
 *   key); undefined for anything else.
 */
export function sniffSave(head: Uint8Array): SaveFormat | undefined {
  const s = (a: number, b: number) => String.fromCharCode(...head.subarray(a, b));
  if (head.length >= 8 && head[0] === 0x89 && s(1, 4) === "PNG") return "png";
  if (head.length >= 12 && s(0, 4) === "glTF") return "glb";
  if (head.length >= 12 && s(0, 4) === "RIFF" && s(8, 12) === "WAVE") return "wav";
  if (/^\{\s*"m_SGVersion"/.test(s(0, Math.min(head.length, 32)))) return "shadergraph";
  return undefined;
}

/** The kind of asset each save format is. */
const FORMAT_KIND: Record<Exclude<SaveFormat, "shadergraph">, AssetKind> = { glb: "model", png: "image", wav: "audio" };

/**
 * Where a save goes: over the original when its format matches (Unity: the same extension; Unreal: the same kind of
 * asset), or a new asset next to it ("Rock-edited.glb", "SM_Rock_Edited") not yet taken. A Shader Graph (the 3D
 * editor's material) always goes in new, next to the model it was made on ("Rock.shadergraph"); Unity only.
 *
 * @param engine - The project's engine.
 * @param rel - The original asset's path.
 * @param format - What the editor saved.
 * @param mode - "replace" or "new".
 * @param taken - Whether a path is taken.
 * @param className - Unreal: the original's class.
 * @returns The target path.
 * @throws With statusCode 400 when replacing is not possible.
 */
export function planSave(engine: AssetEngine, rel: string, format: SaveFormat, mode: "replace" | "new", taken: (rel: string) => boolean, className?: string): string {
  const bad = (why: string) => Object.assign(new Error(why), { statusCode: 400 });
  if (format === "shadergraph") {
    if (engine !== "unity") throw bad("Unreal materials from the 3D editor come next.");
    if (mode !== "new") throw bad("A material graph is saved as a new asset.");
    const stem = `${posix.dirname(rel)}/${nameOf(rel).replace(/[-_]edited(-\d+)?$/i, "")}`;
    for (let i = 1; i < 1000; i++) {
      const next = `${stem}${i > 1 ? `-${i}` : ""}.shadergraph`;
      if (!taken(next)) return next;
    }
    throw bad("Too many material graphs here already.");
  }
  const kind = engine === "unity" ? unityKind(rel) : ASSET_KINDS.find((k) => className && UNREAL_CLASS[k].includes(className));
  if (kind !== FORMAT_KIND[format]) throw bad("This editor's file is not the same kind of asset.");
  if (mode === "replace") {
    if (engine === "unity" && extOf(rel) !== format) throw bad(`The original is .${extOf(rel)} and the editor saves .${format}: use "Save as new asset".`);
    return rel;
  }
  const folder = posix.dirname(rel);
  const base = nameOf(rel).replace(/[-_]edited(-\d+)?$/i, "");
  for (let i = 1; i < 1000; i++) {
    const name = engine === "unity" ? `${base}-edited${i > 1 ? `-${i}` : ""}.${format}` : `${base}_Edited${i > 1 ? `_${i}` : ""}.uasset`;
    const next = `${folder}/${name}`;
    if (!taken(next)) return next;
  }
  throw bad("Too many edited copies here already.");
}

/** A save waiting for (or past) the computer's approval. */
export interface StagedSave {
  id: string;
  engine: AssetEngine;
  project: string;
  projectName: string;
  /** The original asset. */
  path: string;
  /** Where it goes. */
  target: string;
  mode: "replace" | "new";
  format: SaveFormat;
  size: number;
  at: string;
  /** Asked from the phone (or another device): only the computer can approve it. */
  fromPhone: boolean;
  state: "pending" | "working" | "done" | "failed" | "discarded";
  error?: string;
  /** The checkpoint made before the write (restore it from Game projects → Checkpoints). */
  checkpoint?: string;
}

/** What staging needs to know. */
export interface StageInput {
  engine: AssetEngine;
  project: string;
  projectName: string;
  /** Unreal: the project's .uproject. */
  projectFile?: string;
  path: string;
  mode: "replace" | "new";
  fromPhone: boolean;
}

/** Saves kept this long, and at most this many. */
const KEEP_MS = 24 * 60 * 60_000;
const MAX_SAVES = 30;

/**
 * Saves back into game projects: staged (the bytes kept in KesherAI's data folder), then written only when approved on
 * the computer: a checkpoint of what is there first, then the file written in place (Unity) or imported by the plugin
 * (Unreal).
 */
export class ProjectSaves {
  private readonly saves = new Map<string, StagedSave & { projectFile?: string; className?: string }>();

  /**
   * @param o.dir - The staging folder.
   * @param o.checkpoints - The game checkpoints store.
   * @param o.unreal - Runs the plugin's import (tests give a fake).
   * @param o.onStaged - Called when a save from the phone waits (the computer is told).
   * @param o.classOf - An Unreal package's class (default: from its header; tests give their own).
   */
  constructor(private readonly o: { dir: string; checkpoints?: Pick<GameCheckpoints, "beforeSave">; unreal?: UnrealRunner; onStaged?: (s: StagedSave) => void; classOf?: ClassOf }) {}

  private view(s: StagedSave & { projectFile?: string; className?: string }): StagedSave {
    const { projectFile: _f, className: _c, ...v } = s;
    return v;
  }

  private file(id: string): string {
    return join(this.o.dir, `${id}.bin`);
  }

  /** Drops old saves (and their bytes). */
  private async prune(): Promise<void> {
    const now = Date.now();
    const list = [...this.saves.values()].sort((a, b) => a.at.localeCompare(b.at));
    for (const s of list) {
      if (s.state === "working") continue;
      if (now - Date.parse(s.at) > KEEP_MS || this.saves.size > MAX_SAVES) {
        this.saves.delete(s.id);
        await rm(this.file(s.id), { force: true }).catch(() => undefined);
      }
    }
  }

  /**
   * Keeps an editor's file for a save, checked: inside the project, a format the editors write, the right kind, at most
   * 300 MB. Nothing in the project changes yet.
   *
   * @param input - Where it goes and who asked.
   * @param body - The file's bytes (a stream or a buffer).
   * @returns The staged save.
   */
  async stage(input: StageInput, body: Readable | Uint8Array): Promise<StagedSave> {
    const { rel } = await safeAssetPath(input.engine, input.project, input.path);
    const src = join(input.project, rel);
    if (!(await stat(src).catch(() => undefined))?.isFile()) throw Object.assign(new Error("The original asset is not there any more."), { statusCode: 404 });
    const className = input.engine === "unreal" ? await (this.o.classOf ?? headerClass)(src) : undefined;
    if (input.engine === "unreal" && !input.projectFile) throw Object.assign(new Error("The Unreal project file is not known."), { statusCode: 400 });
    await this.prune();
    const id = randomUUID();
    await mkdir(this.o.dir, { recursive: true });
    const tmp = this.file(id);
    let size = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        done(size > MAX_SAVE ? Object.assign(new Error("A file up to 300 MB."), { statusCode: 413 }) : null, chunk);
      },
    });
    try {
      await pipeline(body instanceof Readable ? body : Readable.from([Buffer.from(body)]), cap, createWriteStream(tmp));
      const h = await open(tmp, "r");
      const head = Buffer.alloc(32);
      const { bytesRead } = await h.read(head, 0, 32, 0).finally(() => h.close());
      const format = sniffSave(head.subarray(0, bytesRead));
      if (!format) throw Object.assign(new Error("Only a GLB model, a PNG picture, a WAV sound or a Shader Graph can be saved into a project."), { statusCode: 415 });
      const taken = (r: string) => existsSync(join(input.project, r));
      const target = planSave(input.engine, rel, format, input.mode, taken, className);
      await safeAssetPath(input.engine, input.project, target, format === "shadergraph");
      const s = { id, engine: input.engine, project: input.project, projectName: input.projectName, path: rel, target, mode: input.mode, format, size, at: new Date().toISOString(), fromPhone: input.fromPhone, state: "pending" as const, ...(input.projectFile ? { projectFile: input.projectFile } : {}), ...(className ? { className } : {}) };
      this.saves.set(id, s);
      if (s.fromPhone) this.o.onStaged?.(this.view(s));
      return this.view(s);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  /** Every save kept, newest first. */
  list(): StagedSave[] {
    return [...this.saves.values()].map((s) => this.view(s)).sort((a, b) => b.at.localeCompare(a.at));
  }

  /**
   * One save.
   *
   * @param id - Its id.
   */
  get(id: string): StagedSave | undefined {
    const s = this.saves.get(id);
    return s && this.view(s);
  }

  /**
   * Throws a waiting save away.
   *
   * @param id - Its id.
   * @returns Whether it was waiting.
   */
  async discard(id: string): Promise<boolean> {
    const s = this.saves.get(id);
    if (!s || s.state !== "pending") return false;
    s.state = "discarded";
    await rm(this.file(id), { force: true }).catch(() => undefined);
    return true;
  }

  /**
   * Writes an approved save (call only for a request made on the computer itself): a checkpoint of the target first,
   * then Unity's file written whole-or-not-at-all, or Unreal's asset imported by the plugin.
   *
   * @param id - The save.
   * @returns The save, done or failed.
   */
  async approve(id: string): Promise<StagedSave> {
    const s = this.saves.get(id);
    if (!s) throw Object.assign(new Error("No such save."), { statusCode: 404 });
    if (s.state !== "pending") throw Object.assign(new Error("This save is not waiting any more."), { statusCode: 409 });
    s.state = "working";
    const staged = this.file(id);
    try {
      if (s.engine === "unity") {
        const { abs, rel } = await safeAssetPath("unity", s.project, s.target, s.format === "shadergraph");
        s.checkpoint = (await this.o.checkpoints?.beforeSave("unity", s.project, "editor", `Editor: ${rel}`, [abs]))?.id;
        // Write then rename: Unity never reads half a file.
        await copyFile(staged, `${abs}.kesher-tmp`);
        await rename(`${abs}.kesher-tmp`, abs);
      } else {
        if (!this.o.unreal) throw new Error("Unreal cannot be reached from here.");
        const { abs, rel } = await safeAssetPath("unreal", s.project, s.target);
        s.checkpoint = (await this.o.checkpoints?.beforeSave("unreal", s.project, "editor", `Editor: ${rel}`, [abs]))?.id;
        const file = join(s.project, "Saved", "KesherAI", "imports", `${id}.${s.format}`);
        await mkdir(dirname(file), { recursive: true });
        await copyFile(staged, file);
        try {
          await this.o.unreal(s.projectFile!, "asset_import", { path: gamePackage(rel), file, name: basename(rel, ".uasset") });
        } finally {
          await rm(file, { force: true }).catch(() => undefined);
        }
      }
      s.state = "done";
    } catch (e) {
      s.state = "failed";
      s.error = (e as Error).message;
    }
    await rm(staged, { force: true }).catch(() => undefined);
    return this.view(s);
  }
}
