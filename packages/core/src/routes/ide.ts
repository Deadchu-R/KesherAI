import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { FastifyInstance } from "fastify";
import { findIdes, ideStyle, openInIde, type Ide, type IdeStyle } from "../ide.js";

/**
 * The code editors on this computer (VS Code, Cursor, Antigravity, Rider, Visual Studio): which there are, the look
 * of one (its theme and font, for KesherAI's code panels), and opening a file at a line in one. Reads the editors'
 * settings only; changes nothing in them.
 */
export async function ideRoutes(app: FastifyInstance): Promise<void> {
  let found: { at: number; list: Ide[] } | undefined;
  const ides = async (): Promise<Ide[]> => {
    if (!found || Date.now() - found.at > 60_000) found = { at: Date.now(), list: await findIdes() };
    return found.list;
  };

  // A look is read once a minute at most (it scans the editor's extensions).
  const looks = new Map<string, { at: number; style: IdeStyle }>();
  // Paths of the programs stay on the server: the page needs only which there are.
  app.get("/api/ides", async () => (await ides()).map(({ id, name }) => ({ id, name })));
  app.get<{ Querystring: { id?: string } }>("/api/ides/look", async (req, reply) => {
    const ide = (await ides()).find((x) => x.id === req.query.id);
    if (!ide) return reply.code(404).send({ error: "That editor is not on this computer." });
    const kept = looks.get(ide.id);
    if (kept && Date.now() - kept.at < 60_000) return kept.style;
    const style = await ideStyle(ide);
    looks.set(ide.id, { at: Date.now(), style });
    return style;
  });
  app.post<{ Body: { id?: string; file?: string; line?: number } }>("/api/ides/open", async (req, reply) => {
    const ide = (await ides()).find((x) => x.id === req.body?.id);
    if (!ide) return reply.code(404).send({ error: "That editor is not on this computer." });
    const file = String(req.body?.file ?? "");
    // A file of the computer's (never a URL or a switch for the editor's command line).
    if (!isAbsolute(file) || file.startsWith("-") || !(await stat(file).then((s) => s.isFile(), () => false))) return reply.code(400).send({ error: "No such file." });
    openInIde(ide, file, Number(req.body?.line) || 1);
    return { ok: true };
  });
}
