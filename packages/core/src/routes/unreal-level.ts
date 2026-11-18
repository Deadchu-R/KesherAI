import type { FastifyInstance } from "fastify";
import type { UnrealBridge } from "../unreal-bridge.js";

/**
 * An Unreal level without Unreal (SceneStandIn board): its levels, a level's actors and its meshes' shapes for the 3D
 * editor's stand-in, kept here so they open with Unreal closed, and the moves back (into the open editor as one undo
 * step, or with it closed through a headless editor that saves the level). Plugin 0.1.21+.
 */

const LEVEL = /^\/Game\/[\w ./-]{1,300}$/;
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
  app.get("/api/unreal/levels", async (_req, reply) => {
    try {
      return await b.standIn<{ levels: string[] }>("levels");
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Querystring: { path?: string } }>("/api/unreal/level", async (req, reply) => {
    const path = String(req.query.path ?? "");
    if (!LEVEL.test(path) || path.includes("..")) return reply.code(400).send({ error: "A level under /Game." });
    try {
      return await b.standIn("level", path);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Querystring: { path?: string } }>("/api/unreal/level/mesh", async (req, reply) => {
    const path = String(req.query.path ?? "");
    if (!MESH.test(path) || path.includes("..")) return reply.code(400).send({ error: "A mesh under /Game or /Engine." });
    try {
      return await b.standIn("level_mesh", path);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Body: { path?: string; moves?: unknown[] } }>("/api/unreal/level", async (req, reply) => {
    const path = String(req.body?.path ?? "");
    if (!LEVEL.test(path) || path.includes("..")) return reply.code(400).send({ error: "A level under /Game." });
    const nums = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every((x) => Number.isFinite(x));
    type Move = { id: string; from: { position: number[]; rotation: number[] }; to: { position: number[]; rotation: number[]; scale: number[] } };
    const moves = (Array.isArray(req.body?.moves) ? req.body!.moves.slice(0, 5000) : []).filter((m): m is Move => {
      const x = m as Move;
      return /^[\w.-]{1,200}$/.test(String(x?.id)) && nums(x.from?.position, 3) && nums(x.from?.rotation, 4) && nums(x.to?.position, 3) && nums(x.to?.rotation, 4) && nums(x.to?.scale, 3);
    });
    if (!moves.length) return reply.code(400).send({ error: "Nothing to move." });
    try {
      return await b.moveActors(path, moves.map((m) => ({ id: m.id, from: m.from, to: m.to })));
    } catch (e) {
      return fail(reply, e);
    }
  });
}
