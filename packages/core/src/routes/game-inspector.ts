import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { KesherServices } from "../services.js";
import type { GameProject } from "../game-projects.js";
import { insideProject } from "../game-checkpoints.js";
import { readGodotInspector, readUnityInspector, valueText, type InspectorObject, type ValueEdit, type ValueQueue } from "../game-inspector.js";
import { assetsOf } from "./unity-scene.js";
import { sameFolder } from "../unity-cli.js";

/**
 * The inspector with the engine closed (RESEARCH_LOG "Gap list: engine work without the engine open", 2026-11-20,
 * step 6): a project's scenes, prefabs and assets listed; one read into objects, components and values (Unity YAML,
 * Godot .tscn/.tres; Unreal: the variables of the Blueprint copies saved here, read only); a changed value queued for
 * the next sync, which writes it with the engine closed after a checkpoint and holds it on a clash (game-inspector.ts).
 */

/** The files the inspector reads, per engine. */
const FILES: Record<"unity" | "godot", RegExp> = { unity: /\.(unity|prefab|asset|mat)$/i, godot: /\.(tscn|tres)$/i };
const SKIP = /^(Library|Temp|Logs|obj|Build|Builds|UserSettings|node_modules)$/i;
/** Bigger files are not read here (a huge baked lighting asset is no use in an inspector). */
const MAX_BYTES = 30 * 1024 * 1024;
const MAX_OBJECTS = 3000;

/**
 * The files the inspector can open in a project (at most 3,000, sorted).
 *
 * @param p - The project (Unity or Godot).
 */
export async function inspectableFiles(p: Pick<GameProject, "kind" | "path">): Promise<Array<{ path: string; size: number }>> {
  if (p.kind === "unreal") return [];
  const re = FILES[p.kind];
  const out: Array<{ path: string; size: number }> = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    for (const d of await readdir(join(p.path, rel), { withFileTypes: true }).catch(() => [])) {
      if (out.length >= 3000) return;
      if (d.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth < 12 && !SKIP.test(d.name)) await walk(r, depth + 1);
      } else if (d.isFile() && re.test(d.name)) {
        const st = await stat(join(p.path, r)).catch(() => undefined);
        if (st) out.push({ path: r, size: st.size });
      }
    }
  };
  await walk(p.kind === "unity" ? "Assets" : "", 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A file's place for the inspector: inside the project, an inspectable kind, not in a hidden folder.
 *
 * @param p - The project.
 * @param given - The relative path the page sent.
 * @returns The full path and the relative one.
 */
export function inspectPath(p: Pick<GameProject, "kind" | "path">, given: string): { abs: string; rel: string } {
  if (p.kind === "unreal") throw new Error("Unreal assets are binary: open a Blueprint from the list.");
  const { abs, rel } = insideProject(p.path, String(given ?? "").replace(/\\/g, "/"));
  if (!FILES[p.kind].test(rel) || rel.split("/").some((part) => part.startsWith(".")) || (p.kind === "unity" && !rel.startsWith("Assets/"))) throw new Error("Only the project's scenes, prefabs and assets can be opened here.");
  return { abs, rel };
}

/**
 * Whether the engine has the project open now (values are written into the files only with it closed).
 *
 * @param s - Services.
 * @param p - The project.
 */
export function engineOpen(s: KesherServices, p: Pick<GameProject, "kind" | "path">): boolean {
  if (p.kind === "unity") return existsSync(join(p.path, "Temp", "UnityLockfile")) || (!!s.unity.connected && !!s.unity.activeProject && sameFolder(s.unity.activeProject, p.path));
  if (p.kind === "godot") {
    const st = s.godot.status();
    return !!st.connected && !!st.editor?.projectFile && sameFolder(dirname(st.editor.projectFile), p.path);
  }
  return !!s.unreal.connected && !!s.unreal.projectFile && sameFolder(dirname(s.unreal.projectFile), p.path);
}

/**
 * Writes a project's queued values now, when its engine is closed, with a checkpoint of each file first.
 *
 * @param s - Services.
 * @param values - The queue.
 * @param p - The project (Unity or Godot).
 * @returns The result, or an error when the engine is open.
 */
export async function syncValues(s: KesherServices, values: ValueQueue, p: GameProject): Promise<{ applied: number; clashes: number; failed: number } | { error: string }> {
  if (p.kind === "unreal") return { applied: 0, clashes: 0, failed: 0 };
  if (engineOpen(s, p)) return { error: p.kind === "unity" ? "Close Unity first: changed values are written into the files while Unity is closed." : "Close Godot first: changed values are written into the files while Godot is closed." };
  const group = `sync:values:${Date.now()}`;
  return values.sync(p.kind, p.path, async (abs) => {
    await s.gameCheckpoints?.capture({ engine: p.kind, project: p.path, name: p.name, source: "sync", label: "Sync: inspector values", group }, [abs]).catch(() => undefined);
  });
}

/** An Unreal Blueprint's saved copy as one inspector object (its variables and their defaults, read only). */
function unrealObject(path: string, graph: { name: string; parent?: string; variables: Array<{ name: string; type: string; default?: string; category?: string }> }): InspectorObject {
  return {
    id: path,
    name: graph.name,
    components: [{ target: path, type: graph.parent ? `Blueprint (${graph.parent})` : "Blueprint", fields: graph.variables.slice(0, 500).map((v) => ({ name: v.name, value: `${v.default ?? ""}${v.default ? " " : ""}(${v.type})`, editable: false })) }],
  };
}

/**
 * The inspector's routes.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 * @param findOne - A project found on this computer, by engine and folder (the phone can only name those).
 * @param values - The queue of changed values.
 */
export function gameInspectorRoutes(app: FastifyInstance, s: KesherServices, findOne: (engine: unknown, path: unknown) => Promise<GameProject | undefined>, values: ValueQueue): void {
  const known = async (engine: unknown, project: unknown) => {
    const p = await findOne(engine, project);
    if (!p) throw Object.assign(new Error("Choose one of the projects found on this computer."), { code: 400 });
    return p;
  };
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) => reply.code((err as { code?: number }).code === 409 ? 409 : 400).send({ error: (err as Error).message });
  /** Unreal: the Blueprints of the project Unreal last opened (their copies saved here). */
  const unrealCurrent = async (p: GameProject) => {
    const cur = await s.unreal.project();
    return !!cur && cur.toLowerCase() === p.name.toLowerCase();
  };

  app.get<{ Querystring: { engine?: string; project?: string } }>("/api/games/inspect/files", async (req, reply) => {
    try {
      const p = await known(req.query.engine, req.query.project);
      if (p.kind === "unreal") {
        if (!(await unrealCurrent(p))) return { files: [], note: "Open this project in Unreal once (with the KesherAI Bridge plugin) to list its Blueprints here." };
        const list = await s.unreal.list();
        return { files: list.blueprints.filter((b) => b.saved).map((b) => ({ path: b.path, size: 0 })), readOnly: true };
      }
      return { files: await inspectableFiles(p), readOnly: false };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Querystring: { engine?: string; project?: string; path?: string } }>("/api/games/inspect", async (req, reply) => {
    try {
      const p = await known(req.query.engine, req.query.project);
      if (p.kind === "unreal") {
        const path = String(req.query.path ?? "");
        const saved = (await unrealCurrent(p)) && /^\/Game\//.test(path) ? await s.unreal.savedGraph(path) : undefined;
        if (!saved) return reply.code(404).send({ error: "There is no saved copy of this Blueprint yet: open it once on the Unreal page." });
        return { path, objects: [unrealObject(path, saved.graph)], savedAt: saved.savedAt, readOnly: true, pending: [] };
      }
      const { abs, rel } = inspectPath(p, String(req.query.path ?? ""));
      const st = await stat(abs);
      if (st.size > MAX_BYTES) return reply.code(400).send({ error: "The file is too big to open here." });
      const text = await readFile(abs, "utf8");
      let objects = p.kind === "unity" ? readUnityInspector(text) : readGodotInspector(text);
      const truncated = objects.length > MAX_OBJECTS;
      objects = objects.slice(0, MAX_OBJECTS);
      // Unity: scripts and prefab sources by their file names (from the .meta files).
      let names: Record<string, string> = {};
      if (p.kind === "unity") {
        const guids = new Set<string>();
        for (const o of objects) {
          if (o.prefab?.source) guids.add(o.prefab.source);
          for (const c of o.components) if (c.script) guids.add(c.script);
        }
        names = Object.fromEntries(await assetsOf(p.path, guids));
      }
      const pending = (await values.list()).filter((v) => v.engine === p.kind && sameFolder(v.project, p.path) && v.file === rel);
      return { path: rel, objects, names, mtime: st.mtimeMs, readOnly: false, open: engineOpen(s, p), pending, ...(truncated ? { truncated: true } : {}) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Queues a changed value: checked against the value the page showed (the file may have changed since). */
  app.post<{ Body: { engine?: string; project?: string; path?: string; object?: string; target?: string; name?: string; from?: string; to?: string } }>("/api/games/inspect/value", async (req, reply) => {
    try {
      const p = await known(req.body?.engine, req.body?.project);
      if (p.kind === "unreal") return reply.code(400).send({ error: "Unreal values change through the Blueprint's page or a chat." });
      const { abs, rel } = inspectPath(p, String(req.body?.path ?? ""));
      const target = String(req.body?.target ?? "").slice(0, 300);
      const name = String(req.body?.name ?? "").slice(0, 120);
      const text = await readFile(abs, "utf8");
      const objects = p.kind === "unity" ? readUnityInspector(text) : readGodotInspector(text);
      const field = objects.flatMap((o) => o.components.filter((c) => c.target === target).map((c) => ({ o, f: c.fields.find((f) => f.name === name) }))).find((x) => x.f);
      if (!field?.f) return reply.code(400).send({ error: "That value is not in the file." });
      if (!field.f.editable) return reply.code(400).send({ error: "This value cannot be changed here (a reference or a list)." });
      // A value already waiting is changed from what it will be; otherwise from what the file holds.
      const waiting = (await values.list()).find((v) => v.engine === p.kind && sameFolder(v.project, p.path) && v.file === rel && v.target === target && v.name === name);
      const shown = waiting?.to ?? field.f.value;
      if (req.body?.from !== undefined && String(req.body.from) !== shown) return reply.code(409).send({ error: "The value changed since it was opened. Open the file again." });
      const to = valueText(p.kind, field.f.value, String(req.body?.to ?? ""));
      if (to === field.f.value) {
        if (waiting) await values.remove([waiting.id]);
        return { queued: false };
      }
      const edit = await values.add({ engine: p.kind, project: p.path, file: rel, object: field.o.name.slice(0, 200), target, name, from: field.f.value, to });
      return { queued: true, edit };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/games/inspect/value/:id", async (req, reply) => {
    const n = await values.remove([req.params.id]);
    if (!n) return reply.code(404).send({ error: "That change is no longer waiting." });
    return { ok: true };
  });
}

/**
 * A queued value as one clash on the Sync and conflicts sheet.
 *
 * @param v - The value with its clash.
 * @returns The lines for both sides.
 */
export function valueClashLines(v: ValueEdit): { mine: string[]; engine: string[] } {
  return { mine: [`${v.object} · ${v.name}: ${v.from} → ${v.to}`], engine: [v.clash?.now ? `${v.object} · ${v.name}: ${v.clash.now}` : `${v.object} · ${v.name}: (gone)`] };
}
