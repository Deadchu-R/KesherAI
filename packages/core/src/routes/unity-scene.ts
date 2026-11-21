import type { FastifyInstance } from "fastify";
import type { GameCheckpoints } from "../game-checkpoints.js";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, relative, resolve, sep } from "node:path";
import { mergeMoves, readUnityScene, sceneView, type UnityMove, type UnityObject, type UnitySpriteRect, type UnityView } from "../unity-scene.js";
import { PREFAB_DEPTH, prefabSources } from "../unity-prefabs.js";

/**
 * A Unity scene without Unity (SceneStandIn board): its scenes listed, one read for the stand-in, and the moves made in
 * KesherAI queued in KesherAI/pending-moves.json, which the KesherAI Unity package (0.2.8+; placed prefabs and models: 0.2.9+) applies with Undo when the
 * scene is open (now, if Unity is open with it).
 */

/** The project (it has Assets and ProjectSettings) and a scene in it ("Assets/….unity"), really inside it. */
async function paths(project: unknown, scene?: unknown): Promise<{ dir: string; file?: string; rel?: string }> {
  const dir = resolve(String(project ?? ""));
  if (!existsSync(join(dir, "Assets")) || !existsSync(join(dir, "ProjectSettings"))) throw Object.assign(new Error("That folder is not a Unity project (no Assets and ProjectSettings)."), { statusCode: 400 });
  if (scene === undefined) return { dir };
  const rel = String(scene).replace(/\\/g, "/");
  const file = resolve(dir, rel);
  const bad = () => Object.assign(new Error("A .unity scene under Assets/ or Packages/."), { statusCode: 400 });
  if (!/^(Assets|Packages)\/.+\.unity$/i.test(rel) || rel.split("/").includes("..")) throw bad();
  const real = relative(await realpath(dir), await realpath(file).catch(() => file));
  if (real.startsWith("..") || real.split(sep).includes("..")) throw bad();
  return { dir, file, rel };
}

/** The model files the stand-in can show (three.js reads these). */
const MODEL = /\.(fbx|obj|glb|gltf)$/i;

/** Runs `fn` over `items`, at most `n` at a time (reading thousands of small files one by one took >20 s). */
async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

/** The first bytes of a file, raw (a PNG's size is in its first 24). */
async function headBytes(file: string, bytes: number): Promise<Buffer> {
  const h = await open(file, "r").catch(() => undefined);
  if (!h) return Buffer.alloc(0);
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await h.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await h.close();
  }
}

/** The first bytes of a file as text (a .meta's guid is on its second line). */
async function head(file: string, bytes = 400): Promise<string> {
  return (await headBytes(file, bytes)).toString("utf8");
}

/**
 * Every GUID → file of the .meta files under some folders: the folders are walked first (names only), then the
 * .meta files are read in parallel, 400 bytes each. Stops at `max` files or `budgetMs`.
 *
 * @param dir - The project.
 * @param roots - The folders to look in.
 * @param keep - Which .meta files to read (by name).
 * @param max - The most .meta files read.
 * @param budgetMs - The time allowed.
 * @returns GUID → "Assets/…" (without ".meta"), and whether it stopped early.
 */
async function metaIndex(dir: string, roots: string[], keep: (name: string) => boolean, max: number, budgetMs: number): Promise<{ map: Map<string, string>; partial: boolean }> {
  const until = Date.now() + budgetMs;
  const files: string[] = [];
  let partial = false;
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 16 || files.length >= max) return;
    if (Date.now() > until) { partial = true; return; }
    const subs: string[] = [];
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".") || e.name.endsWith("~")) continue;
      if (e.isDirectory()) subs.push(join(d, e.name));
      else if (e.name.endsWith(".meta") && keep(e.name)) files.push(join(d, e.name));
    }
    await pool(subs, 8, (f) => walk(f, depth + 1));
  };
  for (const r of roots) await walk(r, 0);
  if (files.length >= max) partial = true;
  const map = new Map<string, string>();
  await pool(files.slice(0, max), 48, async (f) => {
    if (Date.now() > until) { partial = true; return; }
    const g = /^guid:\s*([0-9a-f]{32})/m.exec(await head(f))?.[1];
    if (g) map.set(g, relative(dir, f.slice(0, -5)).split(sep).join("/"));
  });
  return { map, partial };
}

/** Each project's Assets index, kept for a minute (the stand-in reads several scenes in a row). */
const assetIndex = new Map<string, { at: number; index: Promise<{ map: Map<string, string>; partial: boolean }> }>();

/**
 * The asset files behind these GUIDs, from the .meta files beside them (Assets/** and embedded packages, indexed
 * once a minute per project; package scripts from Library/PackageCache too).
 *
 * @param dir - The project.
 * @param wanted - The GUIDs.
 * @returns GUID → "Assets/…" (the asset, without ".meta").
 */
export async function assetsOf(dir: string, wanted: Set<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!wanted.size) return out;
  let cached = assetIndex.get(dir);
  if (!cached || Date.now() - cached.at > 60_000) {
    cached = { at: Date.now(), index: metaIndex(dir, [join(dir, "Assets")], () => true, 300_000, 15_000) };
    assetIndex.set(dir, cached);
  }
  const { map } = await cached.index;
  for (const g of wanted) if (map.has(g)) out.set(g, map.get(g)!);
  // Not in Assets (a package's script: TextMeshPro, UI…): the packages' own .meta files, read once per project.
  if (out.size < wanted.size) {
    const packs = await packageAssets(dir);
    for (const g of wanted) if (!out.has(g) && packs.has(g)) out.set(g, packs.get(g)!);
  }
  return out;
}

/** The packages' GUIDs per project (Library/PackageCache and Packages/), read once: they change only with Unity. */
const packageCache = new Map<string, Promise<Map<string, string>>>();
function packageAssets(dir: string): Promise<Map<string, string>> {
  if (!packageCache.has(dir)) {
    // Scripts only: what a scene's component names.
    packageCache.set(dir, metaIndex(dir, [join(dir, "Library", "PackageCache"), join(dir, "Packages")], (n) => n.endsWith(".cs.meta"), 100_000, 15_000).then((r) => r.map));
  }
  return packageCache.get(dir)!;
}

/** A sprite's pivot by its alignment (Center, TopLeft, Top, TopRight, Left, Right, BottomLeft, Bottom, BottomRight). */
const ALIGN: Array<[number, number]> = [[0.5, 0.5], [0, 1], [0.5, 1], [1, 1], [0, 0.5], [1, 0.5], [0, 0], [0.5, 0], [1, 0]];
const pivotOf = (alignment: number, custom: number[]): [number, number] => (alignment === 9 ? [custom[0] ?? 0.5, custom[1] ?? 0.5] : ALIGN[alignment] ?? [0.5, 0.5]);
const xy = (s: string | undefined) => [Number(/x: (-?[\d.e+-]+)/.exec(s ?? "")?.[1] ?? 0.5), Number(/y: (-?[\d.e+-]+)/.exec(s ?? "")?.[1] ?? 0.5)];

/**
 * A picture's sprites from its .meta: pixels per unit, the single sprite (its pivot; its rect from the PNG's size) and
 * a sheet's sprites (Sprite Mode: Multiple) by file id: internalID (2019.3+), or the old name tables.
 *
 * @param dir - The project.
 * @param file - The picture ("Assets/….png").
 * @returns fileID → the sprite's rect, pivot and pixels per unit (the single sprite under "21300000").
 */
async function spritesOf(dir: string, file: string): Promise<Map<string, UnitySpriteRect>> {
  const out = new Map<string, UnitySpriteRect>();
  const metaFile = join(dir, `${file}.meta`);
  if (((await stat(metaFile).catch(() => undefined))?.size ?? Infinity) > 8 * 1024 * 1024) return out;
  const meta = await readFile(metaFile, "utf8").catch(() => "");
  const ppu = Number(/spritePixelsToUnits: ([\d.]+)/.exec(meta)?.[1] ?? 100) || 100;
  // The PNG's own size (its IHDR): the single sprite is the whole picture.
  const png = /\.png$/i.test(file) ? await headBytes(join(dir, file), 32) : undefined;
  const whole = png && png.length >= 24 && png.toString("latin1", 12, 16) === "IHDR" ? [png.readUInt32BE(16), png.readUInt32BE(20)] : undefined;
  out.set("21300000", { ppu, pivot: pivotOf(Number(/spriteAlignment: (\d+)/.exec(meta)?.[1] ?? 0), xy(/spritePivot: (\{[^}]*\})/.exec(meta)?.[1])), ...(whole ? { rect: [0, 0, whole[0]!, whole[1]!] as [number, number, number, number] } : {}) });
  const sheet = meta.split(/^\s*spriteSheet:\s*$/m)[1] ?? "";
  const byName = new Map<string, UnitySpriteRect>();
  for (const chunk of sheet.split(/^\s*- serializedVersion: \d+\s*\n(?=\s*name: )/m).slice(1, 5001)) {
    const name = /^\s*name: (.*)$/m.exec(chunk)?.[1]?.trim();
    const r = /rect:\s*\n(?:\s*serializedVersion: \d+\s*\n)?\s*x: (-?[\d.]+)\s*\n\s*y: (-?[\d.]+)\s*\n\s*width: ([\d.]+)\s*\n\s*height: ([\d.]+)/.exec(chunk);
    if (!name || !r) continue;
    const sprite: UnitySpriteRect = { ppu, rect: [Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4])], pivot: pivotOf(Number(/^\s*alignment: (\d+)/m.exec(chunk)?.[1] ?? 0), xy(/^\s*pivot: (\{[^}]*\})/m.exec(chunk)?.[1])) };
    byName.set(name, sprite);
    const id = /^\s*internalID: (-?\d+)/m.exec(chunk)?.[1];
    if (id && id !== "0") out.set(id, sprite);
  }
  // Older projects name a sheet's sprites by file id in fileIDToRecycleName or internalIDToNameTable.
  for (const m of meta.matchAll(/^\s+(213\d{5}): (.+)$/gm)) if (byName.has(m[2]!.trim())) out.set(m[1]!, byName.get(m[2]!.trim())!);
  for (const m of meta.matchAll(/- first:\s*\n\s*213: (-?\d+)\s*\n\s*second: (.+)/g)) if (byName.has(m[2]!.trim())) out.set(m[1]!, byName.get(m[2]!.trim())!);
  return out;
}

/** The project's sorting layers (ProjectSettings/TagManager.asset): uniqueID → its place in the list (the draw order). */
async function sortingLayers(dir: string): Promise<Map<number, number>> {
  const text = await readFile(join(dir, "ProjectSettings", "TagManager.asset"), "utf8").catch(() => "");
  const ids = [...(text.split(/^\s*m_SortingLayers:\s*$/m)[1] ?? "").matchAll(/^\s*uniqueID: (-?\d+)/gm)].map((m) => Number(m[1]));
  return new Map(ids.map((id, i) => [id, i]));
}

/**
 * The model each object shows: a mesh's file, a placed model itself, or for a placed prefab the first mesh in it.
 *
 * @param dir - The project.
 * @param objects - The scene's objects (changed in place).
 */
async function resolveLooks(dir: string, objects: UnityObject[]): Promise<void> {
  const guids = new Set(objects.flatMap((o) => [...(o.look && "guid" in o.look ? [o.look.guid] : []), ...(o.sprite ? [o.sprite] : []), ...(o.ui?.image ? [o.ui.image] : []), ...(o.tilemap?.sprites ?? []).flatMap((t) => (t.guid ? [t.guid] : [])), ...(o.components ?? []).filter((c) => c.startsWith("script:")).map((c) => c.slice(7))]));
  const files = await assetsOf(dir, guids);
  // Prefabs: their first mesh (a built-in one, or a model), one level deep.
  const inPrefab = new Map<string, UnityObject["look"]>();
  for (const [g, f] of files) {
    if (!/\.prefab$/i.test(f)) continue;
    // A prefab is read only when it is of a sensible size (a huge one stays a box).
    const size = (await stat(join(dir, f)).catch(() => undefined))?.size ?? Infinity;
    const text = size < 20 * 1024 * 1024 ? await readFile(join(dir, f), "utf8").catch(() => "") : "";
    const mesh = /m_Mesh:\s*\{fileID:\s*(-?\d+),\s*guid:\s*([0-9a-f]{32})/.exec(text);
    if (mesh?.[2] === "0000000000000000e000000000000000") {
      const kind = ({ "10202": "cube", "10207": "sphere", "10206": "cylinder", "10208": "capsule", "10209": "plane", "10210": "quad" } as const)[mesh[1] as "10202"];
      if (kind) inPrefab.set(g, { builtin: kind });
    } else if (mesh) inPrefab.set(g, { guid: mesh[2]! });
  }
  const more = await assetsOf(dir, new Set([...inPrefab.values()].flatMap((l) => (l && "guid" in l ? [l.guid] : []))));
  // 2D: each picture's sprites (rects and pivots from its .meta), read once per picture; the sorting layers' order.
  const sheets = new Map<string, Promise<Map<string, UnitySpriteRect>>>();
  const spriteIn = async (file: string, fileID: string) => {
    if (!sheets.has(file)) sheets.set(file, spritesOf(dir, file));
    const all = await sheets.get(file)!;
    return all.get(fileID) ?? all.get("21300000") ?? {};
  };
  const layers = await sortingLayers(dir);
  for (const o of objects) {
    // Scripts by their file's name (as the Inspector shows them), a sprite by its picture's file.
    if (o.components) o.components = o.components.map((c) => (c.startsWith("script:") ? (files.get(c.slice(7))?.split("/").pop() ?? "Script") : c));
    if (o.sprite) { const f = files.get(o.sprite); if (f && /\.(png|jpe?g|webp)$/i.test(f)) o.sprite = f; else delete o.sprite; }
    if (o.spriteInfo) {
      if (o.sprite) Object.assign(o.spriteInfo, await spriteIn(o.sprite, o.spriteInfo.fileID));
      o.spriteInfo.sort[0] = layers.get(o.spriteInfo.sort[0]) ?? 0;
    }
    if (o.tilemap) {
      for (const t of o.tilemap.sprites) {
        const f = t.guid ? files.get(t.guid) : undefined;
        delete t.guid;
        if (f && /\.(png|jpe?g|webp)$/i.test(f)) Object.assign(t, { path: f }, await spriteIn(f, t.fileID));
      }
      o.tilemap.sort[0] = layers.get(o.tilemap.sort[0]) ?? 0;
    }
    // A UI Image's sprite: its picture (a sliced or packed sprite shows its whole picture).
    if (o.ui?.image) { const f = files.get(o.ui.image); if (f && /\.(png|jpe?g|webp)$/i.test(f)) o.ui.image = f; else delete o.ui.image; }
    if (!o.look || !("guid" in o.look)) continue;
    const g = o.look.guid;
    const f = files.get(g);
    if (f && MODEL.test(f)) o.model = f;
    else if (inPrefab.has(g)) {
      const l = inPrefab.get(g)!;
      if ("builtin" in l!) o.look = l;
      else if (more.get(l!.guid) && MODEL.test(more.get(l!.guid)!)) o.model = more.get(l!.guid);
    }
    if (o.look && "guid" in o.look) delete o.look;
  }
}

const fail = (e: unknown) => ({ code: (e as { statusCode?: number }).statusCode ?? 500, error: (e as Error).message });
const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/**
 * A Unity project's scenes: the .unity files under Assets/ and in embedded packages (Packages/<name>/, not the
 * downloaded cache), and those the Build Settings list, skipping hidden and "~" folders (Unity ignores them).
 * Folder links (Windows junctions, symlinks) are followed once. At most 2,000 scenes.
 *
 * @param project - The project's folder.
 * @returns The scenes, sorted, and when there are none a note on why (so the page can say more than "none").
 */
export async function unitySceneList(project: unknown): Promise<{ scenes: string[]; note?: string; reason?: "empty" | "none"; files?: number }> {
  const { dir } = await paths(project);
  const out = new Set<string>();
  const seen = new Set<string>();
  let folders = 0, files = 0;
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 16 || out.size >= 2000 || ++folders > 50_000) return;
    const real = await realpath(d).catch(() => d);
    if (seen.has(real)) return;
    seen.add(real);
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".") || e.name.endsWith("~")) continue;
      const f = join(d, e.name);
      const isDir = e.isDirectory() || (e.isSymbolicLink() && !!(await stat(f).catch(() => undefined))?.isDirectory());
      if (isDir) await walk(f, depth + 1);
      else {
        files++;
        if (/\.unity$/i.test(e.name)) out.add(relative(dir, f).split(sep).join("/"));
      }
    }
  };
  await walk(join(dir, "Assets"), 0);
  for (const e of await readdir(join(dir, "Packages"), { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() || e.isSymbolicLink()) await walk(join(dir, "Packages", e.name), 1);
  }
  // The Build Settings' list (a scene can sit anywhere the project can see).
  const build = await readFile(join(dir, "ProjectSettings", "EditorBuildSettings.asset"), "utf8").catch(() => "");
  for (const m of build.matchAll(/^\s*path:\s*((?:Assets|Packages)\/[^\r\n]+?\.unity)\s*$/gim)) {
    if (!m[1]!.split("/").includes("..") && existsSync(join(dir, m[1]!))) out.add(m[1]!);
  }
  const scenes = [...out].sort();
  if (scenes.length) return { scenes };
  const empty = !existsSync(join(dir, "Assets")) || files === 0;
  const note = empty
    ? "Assets is empty: the project's files may still be downloading, or they are in another folder."
    : `No .unity scene files under Assets or Packages (${files} files looked at). A scene that was never saved in Unity has no file yet.`;
  return { scenes, note, reason: empty ? "empty" : "none", files };
}

/**
 * A Unity project's scenes (see {@link unitySceneList}).
 *
 * @param project - The project's folder.
 * @returns The scenes, sorted.
 */
export async function unityScenes(project: unknown): Promise<string[]> {
  return (await unitySceneList(project)).scenes;
}

/** The biggest scene file read (it is streamed, and only the parts the stand-in shows are kept). */
export const MAX_SCENE_BYTES = 512 * 1024 * 1024;
/** How long reading one scene may take. */
const READ_MS = 20_000;
/** How long finding the models and pictures behind the objects may take (after that the scene shows boxes). */
const LOOKS_MS = 8_000;
/** The most text kept from one scene (scan 171: kept classes can carry big serialized data, e.g. a script's arrays). */
export const MAX_KEPT_CHARS = 64 * 1024 * 1024;
/** A kept line longer than this is cut (names, positions and references are short; long lines are data blobs). */
const MAX_LINE_CHARS = 16 * 1024;
/** The classes the stand-in reads (readUnityScene); every other document keeps only its first line. */
const KEEP = new Set(["1", "4", "224", "33", "114", "212", "223", "1001", "156049354", "483693784", "1839735485"]);

/**
 * Reads a scene file as a stream, keeping only the documents the stand-in uses (GameObjects, Transforms, mesh
 * filters, scripts, sprites, canvases, grids and tilemaps, placed prefabs) and the first line of the rest: a scene with baked meshes, terrain or
 * lighting data shrinks to a small part, and is never held whole.
 *
 * @param file - The .unity file.
 * @param budgetMs - The time allowed.
 * @param maxKept - The most characters kept (past it: 413).
 * @returns The kept text, for readUnityScene (a kept line over 16 K characters is cut).
 * @throws Error with statusCode 415 for a binary scene, 413 when too much is kept, 504 when it took too long.
 */
export async function readSceneText(file: string, budgetMs = READ_MS, maxKept = MAX_KEPT_CHARS): Promise<string> {
  if (!/^%YAML/.test(await head(file, 16))) throw err(415, "This scene is saved in binary. In Unity: Edit → Project Settings → Editor → Asset Serialization: Force Text, then save the scene.");
  const until = Date.now() + budgetMs;
  const parts: string[] = [];
  let keep = true;
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  let n = 0;
  let size = 0;
  for await (const line of lines) {
    if (line.startsWith("--- !u!")) {
      keep = KEEP.has(/^--- !u!(\d+)/.exec(line)?.[1] ?? "");
      parts.push(line);
      size += line.length;
    } else if (keep) {
      const cut = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
      parts.push(cut);
      size += cut.length;
    }
    if (size > maxKept) {
      lines.close();
      throw err(413, "This scene holds too much object data to read here. Open it in Unity.");
    }
    if ((++n & 0xfff) === 0 && Date.now() > until) {
      lines.close();
      throw err(504, "Reading this scene took too long (it is very big). Try a smaller scene, or open it in Unity.");
    }
  }
  return parts.join("\n");
}

/** The time allowed to read the prefabs a scene places (past it: the ones read so far are expanded). */
const PREFABS_MS = 6_000;
/** The most prefab files read for one scene, the biggest one read, and all their kept text together. */
const MAX_PREFABS = 600;
const MAX_PREFAB_BYTES = 20 * 1024 * 1024;
const MAX_PREFAB_CHARS = 96 * 1024 * 1024;

/**
 * The prefabs a scene places, and the prefabs inside those (up to PREFAB_DEPTH levels), as text: found through their
 * .meta files and streamed like a scene (only the documents the stand-in uses). Fills `out` as it goes, so a caller
 * that stops waiting still has the ones read.
 *
 * @param dir - The project.
 * @param text - The scene's kept text.
 * @param out - Prefab GUID → its kept text (filled in).
 * @param until - When to stop (Date.now() time).
 */
async function readPrefabs(dir: string, text: string, out: Map<string, string>, until: number): Promise<void> {
  let wanted = new Set(prefabSources(text));
  let kept = 0;
  for (let depth = 0; depth < PREFAB_DEPTH && wanted.size && Date.now() < until; depth++) {
    const files = [...(await assetsOf(dir, wanted))].filter(([g, f]) => /\.prefab$/i.test(f) && !out.has(g));
    const next = new Set<string>();
    await pool(files, 8, async ([g, f]) => {
      if (out.size >= MAX_PREFABS || kept > MAX_PREFAB_CHARS || Date.now() > until) return;
      const size = (await stat(join(dir, f)).catch(() => undefined))?.size ?? Infinity;
      if (size > MAX_PREFAB_BYTES) return;
      const t = await readSceneText(join(dir, f), Math.max(1, until - Date.now()), MAX_PREFAB_BYTES).catch(() => "");
      if (!t) return;
      out.set(g, t);
      kept += t.length;
      for (const s of prefabSources(t)) if (!out.has(s)) next.add(s);
    });
    wanted = next;
  }
}

/**
 * One scene's objects for the stand-in (their looks resolved to models and built-in shapes; placed prefabs expanded
 * into their objects; UI laid out), read only. Streamed, with a size and a time guard; when finding the models takes
 * too long the objects come without them (`partial`), and prefabs not read in time stay one box each.
 *
 * @param project - The project's folder.
 * @param scene - "Assets/….unity" (or "Packages/….unity") inside it.
 * @returns The objects and the file's time; throws with a statusCode (400 outside, 404 missing, 413 too big, 415
 *   binary, 504 too slow).
 */
export async function unitySceneOf(project: unknown, scene: unknown): Promise<{ objects: UnityObject[]; mtime: number; partial?: boolean; note?: string } & UnityView> {
  const { dir, file } = await paths(project, scene);
  const st = await stat(file!).catch(() => undefined);
  if (!st?.isFile()) throw err(404, "No such scene.");
  if (st.size > MAX_SCENE_BYTES) throw err(413, `The scene is too big to read here (${Math.round(st.size / 1048576)} MB; up to ${MAX_SCENE_BYTES / 1048576} MB).`);
  const text = await readSceneText(file!);
  // The placed prefabs' files, for as long as PREFABS_MS allows (a huge project's index can take longer: then the
  // prefabs read by then are expanded and the others stay boxes).
  const prefabs = new Map<string, string>();
  let wait: NodeJS.Timeout | undefined;
  const read = await Promise.race([readPrefabs(dir, text, prefabs, Date.now() + PREFABS_MS).then(() => "ok" as const), new Promise<"late">((r) => { wait = setTimeout(() => r("late"), PREFABS_MS + 500); })]);
  clearTimeout(wait);
  const objects = readUnityScene(text, new Map(prefabs));
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), LOOKS_MS); });
  const done = await Promise.race([resolveLooks(dir, objects).then(() => "ok" as const), late]);
  clearTimeout(timer);
  if (done === "late") {
    // resolveLooks may still be changing the objects: hand out copies without the unresolved parts.
    const plain = objects.map((o) => { const { look, sprite, components, ui, ...rest } = o; const { image, ...face } = ui ?? ({} as NonNullable<typeof ui>); return { ...rest, ...(look && "builtin" in look ? { look } : {}), ...(components ? { components: components.map((c) => (c.startsWith("script:") ? "Script" : c)) } : {}), ...(sprite && !/^[0-9a-f]{32}$/.test(sprite) ? { sprite } : {}), ...(ui ? { ui: { ...face, ...(image && !/^[0-9a-f]{32}$/.test(image) ? { image } : {}) } } : {}) }; });
    return { objects: plain, ...sceneView(plain), mtime: st.mtimeMs, partial: true, note: "The models are still being found (a big project): the objects show as boxes for now. Open the scene again in a minute." };
  }
  return { objects, ...sceneView(objects), mtime: st.mtimeMs, ...(read === "late" ? { partial: true, note: "Some prefabs were not read in time (a big project): they show as boxes for now. Open the scene again in a minute." } : {}) };
}

/**
 * A model file or picture the scene uses (under Assets/), as bytes.
 *
 * @param project - The project's folder.
 * @param path - "Assets/…" inside it.
 * @returns The bytes; throws with a statusCode.
 */
export async function unityAssetOf(project: unknown, path: unknown): Promise<Buffer> {
  const { dir } = await paths(project);
  const rel = String(path ?? "").replace(/\\/g, "/");
  if (!/^Assets\//.test(rel) || !(MODEL.test(rel) || /\.(png|jpe?g|webp)$/i.test(rel)) || rel.split("/").includes("..")) throw err(400, "A model file or a picture under Assets/.");
  const file = resolve(dir, rel);
  const real = relative(await realpath(dir), await realpath(file).catch(() => file));
  if (real.startsWith("..") || real.split(sep).includes("..")) throw err(400, "A model file under Assets/.");
  const st = await stat(file).catch(() => undefined);
  if (!st?.isFile()) throw err(404, "No such file.");
  if (st.size > 150 * 1024 * 1024) throw err(413, "The model is too big to show here.");
  return readFile(file);
}

/**
 * The routes.
 *
 * @param app - The server.
 */
export async function unitySceneRoutes(app: FastifyInstance, checkpoints?: GameCheckpoints): Promise<void> {
  app.get<{ Querystring: { project?: string } }>("/api/unity/scenes", async (req, reply) => {
    try {
      return await unitySceneList(req.query.project);
    } catch (e) {
      const f = fail(e);
      return reply.code(f.code).send({ error: f.error });
    }
  });

  app.get<{ Querystring: { project?: string; scene?: string } }>("/api/unity/scene", async (req, reply) => {
    try {
      return await unitySceneOf(req.query.project, req.query.scene);
    } catch (e) {
      const f = fail(e);
      return reply.code(f.code).send({ error: f.error });
    }
  });

  // A model file the scene uses (Assets/….fbx / .obj / .glb / .gltf), for the stand-in to show its real shape.
  app.get<{ Querystring: { project?: string; path?: string } }>("/api/unity/asset", async (req, reply) => {
    try {
      const bytes = await unityAssetOf(req.query.project, req.query.path);
      return reply.type("application/octet-stream").send(bytes);
    } catch (e) {
      const f = fail(e);
      return reply.code(f.code).send({ error: f.error });
    }
  });

  // The moves, queued for the package (it applies them as one undo step, and keeps Unity's place for anything that also
  // moved there).
  app.post<{ Body: { project?: string; scene?: string; moves?: UnityMove[] } }>("/api/unity/scene", async (req, reply) => {
    try {
      const { dir, rel } = await paths(req.body?.project, req.body?.scene);
      const nums = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every((x) => Number.isFinite(x));
      const ok = (Array.isArray(req.body?.moves) ? req.body!.moves.slice(0, 5000) : []).filter((m) => /^-?\d{1,20}(:-?\d{1,20})?$/.test(String(m?.id)) && nums(m.to?.position, 3) && nums(m.to?.rotation, 4) && nums(m.to?.scale, 3) && nums(m.from?.position, 3) && nums(m.from?.rotation, 4));
      const file = join(dir, "KesherAI", "pending-moves.json");
      await mkdir(join(dir, "KesherAI"), { recursive: true });
      // The scene and the waiting moves as they are now (restoring drops these moves if Unity has not applied them yet).
      if (ok.length) await checkpoints?.beforeSave("unity", dir, "stand-in", `Stand-in: ${rel}`, [join(dir, rel!), file]);
      const waiting = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as Record<string, UnityMove[]>;
      const next = mergeMoves(waiting, rel!, ok.map((m) => ({ id: String(m.id), name: String(m.name ?? "").slice(0, 200), from: m.from, to: m.to })));
      // Write then rename: the KesherAI package in Unity reads this file when Unity opens (scan 168: never half of it).
      await writeFile(`${file}.tmp`, JSON.stringify(next, null, 1));
      await rename(`${file}.tmp`, file);
      return { queued: ok.length, waiting: next[rel!]!.length };
    } catch (e) {
      const f = fail(e);
      return reply.code(f.code).send({ error: f.error });
    }
  });
}
