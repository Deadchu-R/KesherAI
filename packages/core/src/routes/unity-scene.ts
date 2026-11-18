import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { mergeMoves, readUnityScene, type UnityMove } from "../unity-scene.js";

/**
 * A Unity scene without Unity (SceneStandIn board): its scenes listed, one read for the stand-in, and the moves made in
 * KesherAI queued in KesherAI/pending-moves.json, which the KesherAI Unity package (0.2.8+) applies with Undo when the
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

const fail = (e: unknown) => ({ code: (e as { statusCode?: number }).statusCode ?? 500, error: (e as Error).message });

/**
 * The routes.
 *
 * @param app - The server.
 */
export async function unitySceneRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { project?: string } }>("/api/unity/scenes", async (req, reply) => {
    try {
      const { dir } = await paths(req.query.project);
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
      return { scenes: out.sort() };
    } catch (e) {
      const f = fail(e);
      return reply.code(f.code).send({ error: f.error });
    }
  });

  app.get<{ Querystring: { project?: string; scene?: string } }>("/api/unity/scene", async (req, reply) => {
    try {
      const { file } = await paths(req.query.project, req.query.scene);
      const st = await stat(file!).catch(() => undefined);
      if (!st?.isFile()) return reply.code(404).send({ error: "No such scene." });
      if (st.size > 200 * 1024 * 1024) return reply.code(413).send({ error: "The scene is too big to read here." });
      return { objects: readUnityScene(await readFile(file!, "utf8")), mtime: st.mtimeMs };
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
      const ok = (Array.isArray(req.body?.moves) ? req.body!.moves.slice(0, 5000) : []).filter((m) => /^-?\d{1,20}$/.test(String(m?.id)) && nums(m.to?.position, 3) && nums(m.to?.rotation, 4) && nums(m.to?.scale, 3) && nums(m.from?.position, 3) && nums(m.from?.rotation, 4));
      const file = join(dir, "KesherAI", "pending-moves.json");
      await mkdir(join(dir, "KesherAI"), { recursive: true });
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
