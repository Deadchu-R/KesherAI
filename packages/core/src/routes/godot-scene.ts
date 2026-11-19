import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { copyFile, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { GodotBridge } from "../godot-bridge.js";
import { readTscn, writeTscn, type TscnChange, type TscnNode } from "../tscn.js";

/**
 * A Godot scene without Godot (SceneStandIn board): its scenes listed, a scene's nodes read, and the moves made in
 * KesherAI written back into its .tscn while the Godot editor is closed (when it is open, it would reload the file
 * under her feet, so the write waits and says so).
 */

/** The project's folder (it must have project.godot) and a scene in it ("res://…"), never outside it. */
function paths(project: unknown, scene?: unknown): { dir: string; file?: string } {
  const dir = resolve(String(project ?? "").replace(/[\\/]project\.godot$/i, ""));
  if (!existsSync(join(dir, "project.godot"))) throw Object.assign(new Error("That folder has no project.godot."), { statusCode: 400 });
  if (scene === undefined) return { dir };
  const rel = String(scene).replace(/^res:\/\//, "");
  const file = resolve(dir, rel);
  if (!/\.tscn$/i.test(file) || relative(dir, file).startsWith("..") || relative(dir, file).split(sep).includes("..")) throw Object.assign(new Error("A .tscn inside the project (res://…)."), { statusCode: 400 });
  return { dir, file };
}

/** The scene must really be inside the project: a link inside the folder may not lead the write elsewhere. */
async function inside(dir: string, file: string): Promise<void> {
  const [d, f] = await Promise.all([realpath(dir), realpath(file).catch(() => file)]);
  const rel = relative(d, f);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) throw Object.assign(new Error("A .tscn inside the project (res://…)."), { statusCode: 400 });
}

const same = (a?: number[], b?: number[]) => !!a && !!b && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) < 1e-4);
const flatOf = (n?: TscnNode) => (n?.transform ? [...n.transform.basis, ...n.transform.origin] : n?.position2d);

/**
 * Scenes inside the scene (a door scene placed five times): their nodes come along under the node that places them,
 * marked `inner` (shown for the shape, never saved: they belong to the other file), two levels deep at most.
 */
async function expand(dir: string, nodes: TscnNode[], depth: number): Promise<Array<TscnNode & { inner?: boolean }>> {
  const out: Array<TscnNode & { inner?: boolean }> = [];
  for (const n of nodes) {
    out.push(n);
    if (!n.scene || depth >= 2) continue;
    try {
      const { file } = paths(dir, n.scene);
      await inside(dir, file!);
      const innerNodes = await expand(dir, readTscn(await readFile(file!, "utf8")), depth + 1);
      const root = innerNodes[0];
      // The placed scene's root is this node itself: its look comes over, its children hang under it.
      if (root && !n.shape && !n.model) Object.assign(n, root.shape ? { shape: root.shape } : {}, root.model ? { model: root.model } : {});
      for (const c of innerNodes.slice(1)) out.push({ ...c, path: `${n.path}/${c.path}`, inner: true });
    } catch {
      // A scene that is missing or outside: the node stays a box.
    }
  }
  return out;
}

/** A move and what the node looked like when the stand-in was made, to see whether it moved in Godot too. */
export interface StandInChange extends TscnChange {
  /** The transform it had (12 numbers, or 2 for a 2D position); none: the node was at the default. */
  from?: number[];
}

/**
 * The moves that clash: the node moved in Godot since the stand-in was made (its transform is no longer `from`).
 *
 * @param nodes - The scene as it is now.
 * @param changes - The moves.
 * @returns The paths that clash.
 */
export function clashes(nodes: readonly TscnNode[], changes: readonly StandInChange[]): string[] {
  const by = new Map(nodes.map((n) => [n.path, n]));
  return changes.filter((c) => {
    const now = flatOf(by.get(c.path));
    return c.from ? !same(now, c.from) : !!now;
  }).map((c) => c.path);
}

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/**
 * A Godot project's scenes ("res://….tscn"), skipping hidden folders and addons; at most about 500.
 *
 * @param project - The project's folder (or its project.godot).
 * @returns The scenes, sorted.
 */
export async function godotScenes(project: unknown): Promise<string[]> {
  const { dir } = paths(project);
  const out: string[] = [];
  const walk = async (d: string, depth: number) => {
    if (depth > 6 || out.length > 500) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".") || e.name === "addons") continue;
      if (e.isDirectory()) await walk(join(d, e.name), depth + 1);
      else if (/\.tscn$/i.test(e.name)) out.push(`res://${relative(dir, join(d, e.name)).split(sep).join("/")}`);
    }
  };
  await walk(dir, 0);
  return out.sort();
}

/**
 * One scene's nodes for the stand-in (placed scenes expanded), read only.
 *
 * @param project - The project's folder.
 * @param scene - "res://….tscn" inside it.
 * @returns The nodes and the file's time; throws with a statusCode (400 outside, 404 missing, 413 too big).
 */
export async function godotSceneOf(project: unknown, scene: unknown): Promise<{ nodes: TscnNode[]; mtime: number }> {
  const { dir, file } = paths(project, scene);
  await inside(dir, file!);
  const st = await stat(file!).catch(() => undefined);
  if (st && st.size > 50 * 1024 * 1024) throw err(413, "The scene is too big to read here.");
  if (!st?.isFile()) throw err(404, "No such scene.");
  return { nodes: await expand(dir, readTscn(await readFile(file!, "utf8")), 0), mtime: st.mtimeMs };
}

/**
 * A model file the scene uses (res://….glb / .gltf), or a 2D sprite's picture, as bytes.
 *
 * @param project - The project's folder.
 * @param path - "res://…" inside it.
 * @returns Its media type and bytes; throws with a statusCode.
 */
export async function godotAssetOf(project: unknown, path: unknown): Promise<{ type: string; bytes: Buffer }> {
  const { dir } = paths(project);
  const rel = String(path ?? "").replace(/^res:\/\//, "");
  const file = resolve(dir, rel);
  if (!/\.(glb|gltf|png|jpe?g|webp|svg)$/i.test(file) || rel.split("/").includes("..")) throw err(400, "A model (.glb, .gltf) or a picture (.png, .jpg, .webp, .svg) inside the project.");
  await inside(dir, file);
  const st = await stat(file).catch(() => undefined);
  if (!st?.isFile()) throw err(404, "No such file.");
  if (st.size > 150 * 1024 * 1024) throw err(413, "The model is too big to show here.");
  return { type: /\.glb$/i.test(file) ? "model/gltf-binary" : /\.gltf$/i.test(file) ? "model/gltf+json" : "application/octet-stream", bytes: await readFile(file) };
}

/**
 * The routes.
 *
 * @param app - The server.
 * @param g - The Godot bridge (to know whether the editor is open).
 */
export async function godotSceneRoutes(app: FastifyInstance, g: GodotBridge): Promise<void> {
  app.get<{ Querystring: { project?: string } }>("/api/godot/scenes", async (req, reply) => {
    try {
      return { scenes: await godotScenes(req.query.project) };
    } catch (e) {
      return reply.code((e as { statusCode?: number }).statusCode ?? 500).send({ error: (e as Error).message });
    }
  });

  app.get<{ Querystring: { project?: string; scene?: string } }>("/api/godot/scene", async (req, reply) => {
    try {
      return await godotSceneOf(req.query.project, req.query.scene);
    } catch (e) {
      return reply.code((e as { statusCode?: number }).statusCode ?? 500).send({ error: (e as Error).message });
    }
  });

  // A model file the scene uses (res://….glb / .gltf), or a 2D sprite's picture, for the stand-in to show its real shape.
  app.get<{ Querystring: { project?: string; path?: string } }>("/api/godot/asset", async (req, reply) => {
    try {
      const a = await godotAssetOf(req.query.project, req.query.path);
      // Sent as bytes (never as a page): an .svg is not run here, the stand-in draws it as a picture.
      return reply.type(a.type).header("content-disposition", "attachment").send(a.bytes);
    } catch (e) {
      return reply.code((e as { statusCode?: number }).statusCode ?? 500).send({ error: (e as Error).message });
    }
  });

  // The moves into the file: refused while the Godot editor is open, and per node when it moved in Godot meanwhile
  // (unless `keep: "mine"`); a copy of the scene as it was is kept beside it (.tscn.kesher-bak).
  app.post<{ Body: { project?: string; scene?: string; changes?: StandInChange[]; keep?: "mine" } }>("/api/godot/scene", async (req, reply) => {
    try {
      const { dir, file } = paths(req.body?.project, req.body?.scene);
      await inside(dir, file!);
      const changes = Array.isArray(req.body?.changes) ? req.body!.changes.slice(0, 5000) : [];
      const ok = changes.filter((c) => typeof c?.path === "string" && ((Array.isArray(c.transform?.basis) && c.transform!.basis.length === 9 && Array.isArray(c.transform!.origin) && c.transform!.origin.length === 3 && [...c.transform!.basis, ...c.transform!.origin].every(Number.isFinite)) || (Array.isArray(c.position2d) && c.position2d.length === 2 && c.position2d.every(Number.isFinite) && (c.rotation2d === undefined || Number.isFinite(c.rotation2d)) && (c.scale2d === undefined || (Array.isArray(c.scale2d) && c.scale2d.length === 2 && c.scale2d.every(Number.isFinite))))));
      // Godot is open: the file would be reloaded under her feet, so the addon (0.1.2+) applies the moves in the open
      // scene as one undo step instead, for her to save there.
      if (g.status().connected) {
        const scene = `res://${relative(dir, file!).split(sep).join("/")}`;
        const r = await g.request<{ written: number; missing: string[]; conflicts: string[]; error?: string }>("standin_moves", { scene, changes: ok }, 60_000).catch((e: Error) => ({ error: e.message }) as { error: string });
        if ("error" in r && r.error) return reply.code(409).send({ error: /Unknown command/.test(r.error) ? "Godot is open and its KesherAI addon is older than 0.1.2: update it from the Godot page, or close Godot to save into the file." : r.error, code: "godot-open" });
        return { ...r, inEditor: true };
      }
      const text = await readFile(file!, "utf8");
      const clash = req.body?.keep === "mine" ? [] : clashes(readTscn(text), ok);
      if (clash.length) return reply.code(409).send({ error: "These moved in Godot too.", code: "conflict", conflicts: clash });
      const out = writeTscn(text, ok);
      await copyFile(file!, `${file}.kesher-bak`);
      await writeFile(file!, out.text);
      return { written: ok.length - out.missing.length, missing: out.missing, backup: `${relative(dirname(file!), file!)}.kesher-bak` };
    } catch (e) {
      return reply.code((e as { statusCode?: number }).statusCode ?? 500).send({ error: (e as Error).message });
    }
  });
}
