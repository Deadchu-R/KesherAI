import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { findGameProjects } from "../game-projects.js";
import type { UnrealBridge } from "../unreal-bridge.js";

/**
 * An Unreal level without Unreal (SceneStandIn board): its levels, a level's actors and its meshes' shapes for the 3D
 * editor's stand-in, kept here so they open with Unreal closed, and the moves back (into the open editor as one undo
 * step, or with it closed through a headless editor that saves the level). Plugin 0.1.21+.
 */

const LEVEL = /^\/Game\/[\w ./-]{1,300}$/;

/** What a project's Content folder holds, read from disk. */
export interface ContentScan {
  /** Every .umap as "/Game/…" (up to 500, sorted). */
  levels: string[];
  /** How many .uasset files (Blueprints, meshes, textures, UI…) are there (one-file-per-actor folders left out). */
  assets: number;
}

/**
 * Reads the project's Content folder: its levels (.umap) and how many assets (.uasset) it has, no Unreal needed. A
 * headless editor on Roee's PC answered an empty list for every project (its asset registry was not scanned), so the
 * stand-in showed "No levels"; the files themselves are always there. The asset count tells "no levels, only assets"
 * (a UI or Blueprint-only project) from "an empty folder".
 *
 * @param projectDir - The folder with the .uproject.
 * @returns The levels and the asset count (at most 20,000 files are looked at).
 */
export async function scanContent(projectDir: string): Promise<ContentScan> {
  const content = join(projectDir, "Content");
  const levels: string[] = [];
  let assets = 0;
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (++seen > 20_000) return;
      // One-file-per-actor folders and developer sandboxes hold no levels to open.
      if (d.isDirectory()) {
        if (depth > 0 && !/^(__ExternalActors__|__ExternalObjects__|Collections|Developers)$/i.test(d.name) && !d.name.startsWith(".")) await walk(join(dir, d.name), depth - 1);
      } else if (/\.uasset$/i.test(d.name)) {
        assets++;
      } else if (/\.umap$/i.test(d.name) && levels.length < 500) {
        const rel = relative(content, join(dir, d.name)).split(sep).join("/").replace(/\.umap$/i, "");
        const path = `/Game/${rel}`;
        if (LEVEL.test(path) && !path.includes("..")) levels.push(path);
      }
    }
  };
  await walk(content, 12);
  return { levels: levels.sort((a, b) => a.localeCompare(b)), assets };
}

/**
 * The project's levels read from disk: every .umap under Content/ as "/Game/…".
 *
 * @param projectDir - The folder with the .uproject.
 * @returns Up to 500 level paths, sorted.
 */
export async function levelsOnDisk(projectDir: string): Promise<string[]> {
  return (await scanContent(projectDir)).levels;
}

/** The plugin's descriptor inside a project: its absence means the editor cannot list levels, so do not start one. */
const hasPlugin = (dir: string): boolean => existsSync(join(dir, "Plugins", "KesherAIBridge", "KesherAIBridge.uplugin"));
const MESH = /^\/(Game|Engine)\/[\w ./-]{1,300}$/;
const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => {
  const m = (e as Error).message;
  // The project's plugin is older than the stand-in (0.1.21): say what to do, not "Unknown command".
  if (/Unknown command: level/.test(m)) return reply.code(409).send({ error: "The KesherAI Bridge plugin in this project is older than 0.1.21: update it from the Unreal page (Update the plugin), open the project once so Unreal builds it, then try again.", code: "plugin-old" });
  return reply.code(/not connected|does not know|closed/i.test(m) ? 409 : 502).send({ error: m });
};

/**
 * The routes.
 *
 * @param app - The server.
 * @param b - The Unreal bridge.
 */
export async function unrealLevelRoutes(app: FastifyInstance, b: UnrealBridge): Promise<void> {
  // A project chosen from the menu: only one found on this computer (from the phone too), as its .uproject.
  const projectFile = async (project: unknown): Promise<string | undefined | null> => {
    if (!project) return undefined;
    const found = (await findGameProjects({ ...(b.projectFile ? { unrealFile: b.projectFile } : {}) })).find((p) => p.kind === "unreal" && p.path.toLowerCase() === String(project).toLowerCase());
    return found ? join(found.path, `${found.name}.uproject`) : null;
  };
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => reply.code(403).send({ error: "Choose one of the Unreal projects found on the computer." });
  app.get<{ Querystring: { project?: string } }>("/api/unreal/levels", async (req, reply) => {
    const pf = await projectFile(req.query.project);
    if (pf === null) return bad(reply);
    // The file list from disk fills in when the editor (open or headless) gives none or cannot run.
    const dir = pf ? dirname(pf) : b.knownProjectFile ? dirname(b.knownProjectFile) : undefined;
    // A project without the plugin has no editor to ask (starting one would only wait to fail): the files answer.
    // The answer says `fromDisk` (opening a level needs the plugin) and, with no levels, how many assets there are.
    const fromFiles = async (note?: string) => {
      const scan = dir ? await scanContent(dir) : { levels: [], assets: 0 };
      return { levels: scan.levels, fromDisk: true, assets: scan.assets, ...(note ? { note } : {}) };
    };
    if (pf && dir && !hasPlugin(dir)) return fromFiles();
    try {
      const r = await b.standIn<{ levels: string[] }>("levels", "", pf);
      if (!r.levels?.length && dir) {
        const scan = await scanContent(dir);
        return scan.levels.length ? { ...r, levels: scan.levels, fromDisk: true } : { ...r, assets: scan.assets };
      }
      return r;
    } catch (e) {
      const disk = await fromFiles((e as Error).message);
      if (disk.levels.length || (dir && disk.assets > 0)) return disk;
      return fail(reply, e);
    }
  });

  app.get<{ Querystring: { path?: string; project?: string } }>("/api/unreal/level", async (req, reply) => {
    const path = String(req.query.path ?? "");
    if (!LEVEL.test(path) || path.includes("..")) return reply.code(400).send({ error: "A level under /Game." });
    const pf = await projectFile(req.query.project);
    if (pf === null) return bad(reply);
    try {
      return await b.standIn("level", path, pf);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Querystring: { path?: string; project?: string } }>("/api/unreal/level/mesh", async (req, reply) => {
    const path = String(req.query.path ?? "");
    if (!MESH.test(path) || path.includes("..")) return reply.code(400).send({ error: "A mesh under /Game or /Engine." });
    const pf = await projectFile(req.query.project);
    if (pf === null) return bad(reply);
    try {
      return await b.standIn("level_mesh", path, pf);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Body: { path?: string; moves?: unknown[]; project?: string } }>("/api/unreal/level", async (req, reply) => {
    const path = String(req.body?.path ?? "");
    if (!LEVEL.test(path) || path.includes("..")) return reply.code(400).send({ error: "A level under /Game." });
    const pf = await projectFile(req.body?.project);
    if (pf === null) return bad(reply);
    const nums = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every((x) => Number.isFinite(x));
    type Move = { id: string; from: { position: number[]; rotation: number[] }; to: { position: number[]; rotation: number[]; scale: number[] } };
    const moves = (Array.isArray(req.body?.moves) ? req.body!.moves.slice(0, 5000) : []).filter((m): m is Move => {
      const x = m as Move;
      return /^[\w.-]{1,200}$/.test(String(x?.id)) && nums(x.from?.position, 3) && nums(x.from?.rotation, 4) && nums(x.to?.position, 3) && nums(x.to?.rotation, 4) && nums(x.to?.scale, 3);
    });
    if (!moves.length) return reply.code(400).send({ error: "Nothing to move." });
    try {
      return await b.moveActors(path, moves.map((m) => ({ id: m.id, from: m.from, to: m.to })), pf);
    } catch (e) {
      return fail(reply, e);
    }
  });
}
