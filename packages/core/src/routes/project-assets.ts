import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { withBusy } from "../busy.js";
import { flatToPng } from "../flat-image.js";
import type { GameProject } from "../game-projects.js";
import { ASSET_KINDS, MAX_OPEN, ProjectSaves, listUnityAssets, listUnrealAssets, pluginCanExport, projectPluginVersion, safeAssetPath, unrealExport, type AssetEngine, type AssetKind, type UnrealRunner } from "../project-assets.js";
import { isLocalRequest } from "../request-origin.js";
import { unitySceneOf } from "./unity-scene.js";

/**
 * The editors' "Open from project" (project-assets.ts): the found Unity and Unreal projects, their assets by kind, an
 * asset's bytes (Unreal ones exported by the plugin, kept), a prefab as objects, and saves back that wait for the
 * computer's approval. Every project must be one found on this computer (from the phone too).
 */

/** The note shown while the plugin exports (the editors show "Reading with Unreal in the background…"). */
const READING = { en: "Reading with Unreal in the background", he: "קורא עם Unreal ברקע" };
/** The content type an editor's save is sent as (streamed to disk, never held whole). */
export const SAVE_TYPE = "application/x-kesher-asset";

/** What the routes need. */
export interface ProjectAssetDeps {
  /** The found projects (Unity and Unreal ones are used). */
  found: () => Promise<GameProject[]>;
  /** KesherAI's data folder (exports are kept under it). */
  dataDir: string;
  /** Runs the plugin's export or import on a project. */
  unreal?: UnrealRunner;
  checkpoints?: ConstructorParameters<typeof ProjectSaves>[0]["checkpoints"];
  /** Tells the computer a save from the phone waits for it. */
  notify?: (title: string, body: string) => void;
  /** Whether a request came from this computer (tests give their own). */
  isLocal?: (req: Parameters<typeof isLocalRequest>[0]) => boolean;
}

const fail = (reply: FastifyReply, e: unknown) => {
  const err = e as Error & { statusCode?: number };
  const m = err.message;
  // A plugin older than 0.1.33 does not know the command: say what to do.
  if (/Unknown command: asset_/.test(m)) return reply.code(409).send({ error: "Update the plugin to open this (KesherAI Bridge 0.1.33+: the Unreal page → Update the plugin).", code: "plugin-old" });
  const code = err.statusCode ?? (/not connected|does not know|closed|is open on this project/i.test(m) ? 409 : /ENOENT/.test(m) ? 404 : 502);
  return reply.code(code).send({ error: m });
};

/**
 * The routes.
 *
 * @param app - The server.
 * @param d - What they need.
 * @returns The saves store (for the server's own use and tests).
 */
export async function projectAssetRoutes(app: FastifyInstance, d: ProjectAssetDeps): Promise<ProjectSaves> {
  const local = d.isLocal ?? isLocalRequest;
  const saves = new ProjectSaves({
    dir: join(d.dataDir, "project-assets", "pending"),
    ...(d.checkpoints ? { checkpoints: d.checkpoints } : {}),
    ...(d.unreal ? { unreal: d.unreal } : {}),
    onStaged: (s) => d.notify?.(`שמירה מהטלפון מחכה · A save from the phone waits: ${s.projectName}`, `${s.target} — אשר במחשב (פרויקטי משחק) · approve it on the computer (Game projects).`),
  });
  const cacheDir = join(d.dataDir, "project-assets", "unreal-exports");

  /** One found project of an engine, by its folder. */
  const projectOf = async (engine: unknown, path: unknown): Promise<(GameProject & { kind: AssetEngine }) | undefined> => {
    if (engine !== "unity" && engine !== "unreal") return undefined;
    const want = String(path ?? "").replace(/[\\/]+$/, "").toLowerCase();
    return (await d.found()).find((p): p is GameProject & { kind: AssetEngine } => p.kind === engine && p.path.replace(/[\\/]+$/, "").toLowerCase() === want);
  };
  const notFound = (reply: FastifyReply) => reply.code(403).send({ error: "Choose one of the projects found on this computer." });
  const uproject = (p: GameProject) => join(p.path, `${p.name}.uproject`);

  app.addContentTypeParser(SAVE_TYPE, (_req, payload, done) => done(null, payload));

  app.get("/api/project-assets/projects", async () => {
    const list = (await d.found()).filter((p) => p.kind === "unity" || p.kind === "unreal");
    return { projects: await Promise.all(list.map(async (p) => {
      const plugin = p.kind === "unreal" ? await projectPluginVersion(p.path) : undefined;
      return { engine: p.kind, name: p.name, path: p.path, ...(p.kind === "unreal" ? { plugin: plugin ?? null, canExport: pluginCanExport(plugin) } : {}) };
    })) };
  });

  app.get<{ Querystring: { engine?: string; project?: string; kind?: string } }>("/api/project-assets/list", async (req, reply) => {
    const p = await projectOf(req.query.engine, req.query.project);
    if (!p) return notFound(reply);
    const kinds = String(req.query.kind ?? "").split(",").filter((k): k is AssetKind => (ASSET_KINDS as readonly string[]).includes(k));
    if (!kinds.length) return reply.code(400).send({ error: "Say which kinds: model, image, audio or video." });
    const r = p.kind === "unity" ? await listUnityAssets(p.path, kinds) : await listUnrealAssets(p.path, kinds);
    const plugin = p.kind === "unreal" ? await projectPluginVersion(p.path) : undefined;
    return { ...r, ...(p.kind === "unreal" ? { plugin: plugin ?? null, canExport: pluginCanExport(plugin) } : {}) };
  });

  // An asset's bytes for an editor: Unity's file (TGA and PSD as PNG), or Unreal's export (made once, kept).
  app.get<{ Querystring: { engine?: string; project?: string; path?: string } }>("/api/project-assets/file", async (req, reply) => {
    const p = await projectOf(req.query.engine, req.query.project);
    if (!p) return notFound(reply);
    try {
      const { abs, rel } = await safeAssetPath(p.kind, p.path, req.query.path);
      const st = await stat(abs);
      if (!st.isFile()) return reply.code(404).send({ error: "No such file." });
      if (st.size > MAX_OPEN) return reply.code(413).send({ error: "This file is too big to open here." });
      if (p.kind === "unity" || !/\.uasset$/i.test(rel)) {
        if (/\.prefab$/i.test(rel)) return reply.code(400).send({ error: "A prefab opens as objects (/api/project-assets/prefab)." });
        const ext = rel.split(".").pop()!.toLowerCase();
        if (ext === "tga" || ext === "psd") {
          if (st.size > 128 * 1024 * 1024) return reply.code(413).send({ error: "This picture is too big to open here." });
          return reply.header("x-kesher-format", "png").type("image/png").send(flatToPng(await readFile(abs), ext));
        }
        return reply.header("x-kesher-format", ext).type("application/octet-stream").send(createReadStream(abs));
      }
      if (!pluginCanExport(await projectPluginVersion(p.path))) return reply.code(409).send({ error: "Update the plugin to open this (KesherAI Bridge 0.1.33+: the Unreal page → Update the plugin).", code: "plugin-old" });
      if (!d.unreal) return reply.code(409).send({ error: "Unreal cannot be reached from here." });
      const run = d.unreal;
      const r = await withBusy(READING, () => unrealExport({ cacheDir, project: p.path, projectFile: uproject(p), rel, run }));
      return reply.header("x-kesher-format", r.format).header("x-kesher-cached", r.cached ? "1" : "0").type("application/octet-stream").send(createReadStream(r.file));
    } catch (e) {
      return fail(reply, e);
    }
  });

  // A Unity prefab as objects (the 3D editor puts it together from its meshes, as the scene stand-in does).
  app.get<{ Querystring: { project?: string; path?: string } }>("/api/project-assets/prefab", async (req, reply) => {
    const p = await projectOf("unity", req.query.project);
    if (!p) return notFound(reply);
    try {
      const { rel } = await safeAssetPath("unity", p.path, req.query.path);
      return await unitySceneOf(p.path, rel, "prefab");
    } catch (e) {
      return fail(reply, e);
    }
  });

  // A save: kept here, written only when the computer approves it.
  app.post<{ Querystring: { engine?: string; project?: string; path?: string; mode?: string } }>("/api/project-assets/save", async (req, reply) => {
    const p = await projectOf(req.query.engine, req.query.project);
    if (!p) return notFound(reply);
    if (!String(req.headers["content-type"] ?? "").startsWith(SAVE_TYPE)) return reply.code(415).send({ error: `Send the file as ${SAVE_TYPE}.` });
    try {
      const s = await saves.stage({ engine: p.kind, project: p.path, projectName: p.name, ...(p.kind === "unreal" ? { projectFile: uproject(p) } : {}), path: String(req.query.path ?? ""), mode: req.query.mode === "replace" ? "replace" : "new", fromPhone: !local(req) }, req.body as Readable);
      return { save: s, canApprove: local(req) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get("/api/project-assets/saves", async (req) => ({ saves: saves.list(), canApprove: local(req) }));

  app.get<{ Params: { id: string } }>("/api/project-assets/saves/:id", async (req, reply) => {
    const s = saves.get(req.params.id);
    return s ? { save: s, canApprove: local(req) } : reply.code(404).send({ error: "No such save." });
  });

  // Only on the computer itself: a phone (or anyone with the remote link) can ask, never write into a project alone.
  app.post<{ Params: { id: string } }>("/api/project-assets/saves/:id/approve", async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: "Approve this on the computer.", code: "computer-only" });
    try {
      const s = await saves.approve(req.params.id);
      return { save: s };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>("/api/project-assets/saves/:id/discard", async (req, reply) => {
    return (await saves.discard(req.params.id)) ? { ok: true } : reply.code(404).send({ error: "No such waiting save." });
  });

  return saves;
}

