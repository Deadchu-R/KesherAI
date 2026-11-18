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

/**
 * The routes.
 *
 * @param app - The server.
 * @param g - The Godot bridge (to know whether the editor is open).
 */
export async function godotSceneRoutes(app: FastifyInstance, g: GodotBridge): Promise<void> {
  app.get<{ Querystring: { project?: string } }>("/api/godot/scenes", async (req, reply) => {
    try {
      const { dir } = paths(req.query.project);
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
      return { scenes: out.sort() };
    } catch (e) {
      return reply.code((e as { statusCode?: number }).statusCode ?? 500).send({ error: (e as Error).message });
    }
  });

  app.get<{ Querystring: { project?: string; scene?: string } }>("/api/godot/scene", async (req, reply) => {
    try {
      const { dir, file } = paths(req.query.project, req.query.scene);
      await inside(dir, file!);
      const st = await stat(file!).catch(() => undefined);
      if (!st?.isFile()) return reply.code(404).send({ error: "No such scene." });
      return { nodes: readTscn(await readFile(file!, "utf8")), mtime: st.mtimeMs };
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
      if (g.status().connected) return reply.code(409).send({ error: "Godot is open: close it to save into the scene, or apply the moves there.", code: "godot-open" });
      const changes = Array.isArray(req.body?.changes) ? req.body!.changes.slice(0, 5000) : [];
      const ok = changes.filter((c) => typeof c?.path === "string" && ((Array.isArray(c.transform?.basis) && c.transform!.basis.length === 9 && Array.isArray(c.transform!.origin) && c.transform!.origin.length === 3 && [...c.transform!.basis, ...c.transform!.origin].every(Number.isFinite)) || (Array.isArray(c.position2d) && c.position2d.length === 2 && c.position2d.every(Number.isFinite))));
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
