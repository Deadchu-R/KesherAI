import type { FastifyInstance } from "fastify";
import type { GameCheckpoints } from "../game-checkpoints.js";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { mergeMoves, readUnityScene, type UnityMove, type UnityObject } from "../unity-scene.js";

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
  const bad = () => Object.assign(new Error("A .unity scene under Assets/."), { statusCode: 400 });
  if (!/^Assets\/.+\.unity$/i.test(rel) || rel.split("/").includes("..")) throw bad();
  const real = relative(await realpath(dir), await realpath(file).catch(() => file));
  if (real.startsWith("..") || real.split(sep).includes("..")) throw bad();
  return { dir, file, rel };
}

/** The model files the stand-in can show (three.js reads these). */
const MODEL = /\.(fbx|obj|glb|gltf)$/i;

/**
 * The asset files behind these GUIDs, from the .meta files beside them (Assets/**, stopping once all are found).
 *
 * @param dir - The project.
 * @param wanted - The GUIDs.
 * @returns GUID → "Assets/…" (the asset, without ".meta").
 */
export async function assetsOf(dir: string, wanted: Set<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let seen = 0;
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 12 || out.size === wanted.size || seen > 200_000) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (out.size === wanted.size) return;
      if (e.name.startsWith(".")) continue;
      const f = join(d, e.name);
      if (e.isDirectory()) await walk(f, depth + 1);
      else if (e.name.endsWith(".meta")) {
        seen++;
        const g = /^guid:\s*([0-9a-f]{32})/m.exec((await readFile(f, "utf8").catch(() => "")).slice(0, 400))?.[1];
        if (g && wanted.has(g)) out.set(g, relative(dir, f.slice(0, -5)).split(sep).join("/"));
      }
    }
  };
  if (wanted.size) await walk(join(dir, "Assets"), 0);
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
    packageCache.set(dir, (async () => {
      const out = new Map<string, string>();
      let seen = 0;
      const walk = async (d: string, depth: number): Promise<void> => {
        if (depth > 10 || seen > 100_000) return;
        for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
          const f = join(d, e.name);
          if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "Tests" && e.name !== "Documentation~") await walk(f, depth + 1); }
          // Scripts only: what a scene's component names.
          else if (e.name.endsWith(".cs.meta")) {
            seen++;
            const g = /^guid:\s*([0-9a-f]{32})/m.exec((await readFile(f, "utf8").catch(() => "")).slice(0, 400))?.[1];
            if (g) out.set(g, relative(dir, f.slice(0, -5)).split(sep).join("/"));
          }
        }
      };
      await walk(join(dir, "Library", "PackageCache"), 0);
      await walk(join(dir, "Packages"), 0);
      return out;
    })());
  }
  return packageCache.get(dir)!;
}

/**
 * The model each object shows: a mesh's file, a placed model itself, or for a placed prefab the first mesh in it.
 *
 * @param dir - The project.
 * @param objects - The scene's objects (changed in place).
 */
async function resolveLooks(dir: string, objects: UnityObject[]): Promise<void> {
  const guids = new Set(objects.flatMap((o) => [...(o.look && "guid" in o.look ? [o.look.guid] : []), ...(o.sprite ? [o.sprite] : []), ...(o.components ?? []).filter((c) => c.startsWith("script:")).map((c) => c.slice(7))]));
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
  for (const o of objects) {
    // Scripts by their file's name (as the Inspector shows them), a sprite by its picture's file.
    if (o.components) o.components = o.components.map((c) => (c.startsWith("script:") ? (files.get(c.slice(7))?.split("/").pop() ?? "Script") : c));
    if (o.sprite) { const f = files.get(o.sprite); if (f && /\.(png|jpe?g|webp)$/i.test(f)) o.sprite = f; else delete o.sprite; }
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
 * A Unity project's scenes ("Assets/….unity"), skipping hidden folders; at most about 500.
 *
 * @param project - The project's folder.
 * @returns The scenes, sorted.
 */
export async function unityScenes(project: unknown): Promise<string[]> {
  const { dir } = await paths(project);
  const out: string[] = [];
  const walk = async (d: string, depth: number) => {
    if (depth > 8 || out.length > 500) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) await walk(join(d, e.name), depth + 1);
      else if (/\.unity$/i.test(e.name)) out.push(relative(dir, join(d, e.name)).split(sep).join("/"));
    }
  };
  await walk(join(dir, "Assets"), 0);
  return out.sort();
}

/**
 * One scene's objects for the stand-in (their looks resolved to models and built-in shapes), read only.
 *
 * @param project - The project's folder.
 * @param scene - "Assets/….unity" inside it.
 * @returns The objects and the file's time; throws with a statusCode (400 outside, 404 missing, 413 too big).
 */
export async function unitySceneOf(project: unknown, scene: unknown): Promise<{ objects: UnityObject[]; mtime: number }> {
  const { dir, file } = await paths(project, scene);
  const st = await stat(file!).catch(() => undefined);
  if (!st?.isFile()) throw err(404, "No such scene.");
  if (st.size > 200 * 1024 * 1024) throw err(413, "The scene is too big to read here.");
  const objects = readUnityScene(await readFile(file!, "utf8"));
  await resolveLooks(dir, objects);
  return { objects, mtime: st.mtimeMs };
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
      return { scenes: await unityScenes(req.query.project) };
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
      await writeFile(file, JSON.stringify(next, null, 1));
      return { queued: ok.length, waiting: next[rel!]!.length };
    } catch (e) {
      const f = fail(e);
      return reply.code(f.code).send({ error: f.error });
    }
  });
}
