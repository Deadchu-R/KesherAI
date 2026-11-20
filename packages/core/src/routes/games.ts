import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { KesherServices } from "../services.js";
import { findGameProjects, type GameProject } from "../game-projects.js";
import { graphDiff, opsSummary, type ClashChoice, type SyncReport } from "../game-sync.js";
import { sameFolder } from "../unity-cli.js";
import type { BlueprintJson, QueuedEdit } from "../unreal-bridge.js";

/**
 * The Game projects home (RESEARCH_LOG "Gap list: engine work without the engine open", 2026-11-20, step 1): one page
 * for the Unity, Unreal and Godot projects on this computer, each with its engine version, whether its editor is open,
 * the changes waiting to sync (made with the editor closed), the last sync and its problems; "Sync now"; and the Sync
 * and conflicts sheet, where every queued change that clashes with an edit made in the engine waits for Roee's choice
 * (his rule: ask every time). A phone notification goes out only when a sync fails or finds a clash.
 */

/** One project on the page. */
export interface GameProjectState {
  engine: GameProject["kind"];
  name: string;
  path: string;
  version?: string;
  /** The editor has this project open now (Unity: also its lock file, for projects other than the one shown). */
  open: boolean;
  /** Changes waiting to go in: graph edits and (Unity) scene stand-in moves. */
  pending: number;
  moves?: number;
  /** Queued changes that clash with an edit made in the engine (waiting for a choice). */
  clashes: number;
  running?: boolean;
  lastSync?: string;
  problem?: string;
  /** Whether "Sync now" can run for it here. */
  canSync: boolean;
  /** Its page in the app. */
  page: string;
}

/** One clash on the Sync and conflicts sheet. */
export interface GameClash {
  id: string;
  engine: "unreal" | "unity";
  project: string;
  /** The queue's project: the folder (Unity) or the name (Unreal). */
  key: string;
  /** The graph: object path (Unreal) or asset path (Unity). */
  path: string;
  name: string;
  request?: string;
  queuedAt: string;
  baseAt?: string;
  engineAt: string;
  decision?: "mine" | "skip";
  /** My side: one line per queued operation. */
  mine: string[];
  /** The engine's side: nodes added and removed since the copy the change was made on (read only when the editor is open). */
  diff?: { added: string[]; removed: string[] };
}

/** The graph's short name, from its path. */
const shortName = (path: string) => (path.split("#")[0]!.split("/").pop() ?? path).replace(/\.[^.]*$/, "") + (path.includes("#") ? ` · ${path.split("#")[1]}` : "");

/**
 * The note for a sync that failed or found a clash (none otherwise: Roee asked for notifications only then).
 *
 * @param r - How the sync ended.
 * @returns The note's title and body, or undefined when all went in.
 */
export function syncNote(r: SyncReport): { title: string; body: string } | undefined {
  const name = r.engine === "unity" ? basename(r.project) : r.project;
  const app = r.engine === "unity" ? "Unity" : "Unreal";
  if (r.clashes) return { title: `התנגשות בסנכרון · Sync clash: ${name}`, body: `${r.clashes} שינויים נערכו גם ב-${app}. בחר מה לשמור. · ${r.clashes} change(s) were also edited in ${app}. Choose what to keep.` };
  if (r.error) return { title: `הסנכרון נכשל · Sync failed: ${name}`, body: r.error };
  return undefined;
}

/**
 * The Game projects routes.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function gamesRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  // Notify only on a failure or a clash; tapping the note opens the Sync and conflicts sheet.
  const onSync = (r: SyncReport) => {
    const n = syncNote(r);
    if (n) void s.notifier.send({ ...n, path: "#/games?sync=1", tags: [r.clashes ? "twisted_rightwards_arrows" : "warning"], priority: 4 }).catch(() => undefined);
  };
  s.unreal.onSync = onSync;
  s.unity.onSync = onSync;

  /** The projects found on this computer (the same list the stand-ins use, so a phone can only name these). */
  let cache: { at: number; list: Promise<GameProject[]> } | undefined;
  const found = async () => {
    // The page asks every few seconds; the folders are scanned at most every 30 seconds.
    if (cache && Date.now() - cache.at < 30_000) return cache.list;
    const godotFile = s.godot.status().editor?.projectFile;
    const list = findGameProjects({
      unity: s.config.unity.projects,
      ...(s.unreal.projectFile ? { unrealFile: s.unreal.projectFile } : {}),
      ...(godotFile ? { godot: [dirname(godotFile)] } : {}),
    });
    cache = { at: Date.now(), list };
    list.catch(() => { cache = undefined; });
    return list;
  };
  const findOne = async (engine: unknown, path: unknown) => (await found()).find((p) => p.kind === engine && typeof path === "string" && sameFolder(p.path, path));

  app.get("/api/games", async () => {
    const [list, uq, unityQ, unrealProject] = await Promise.all([found(), s.unreal.queue(), s.unity.queue(), s.unreal.project()]);
    const godot = s.godot.status();
    const unrealOpenDir = s.unreal.connected && s.unreal.projectFile ? dirname(s.unreal.projectFile) : undefined;
    const projects: GameProjectState[] = await Promise.all(list.map(async (p): Promise<GameProjectState> => {
      const base = { engine: p.kind, name: p.name, path: p.path, ...(p.engine ? { version: p.engine } : {}) };
      if (p.kind === "unreal") {
        const mine = uq.filter((q) => q.project.toLowerCase() === p.name.toLowerCase());
        const current = !!unrealProject && unrealProject.toLowerCase() === p.name.toLowerCase();
        const st = current ? s.unreal.syncState : undefined;
        return {
          ...base,
          open: !!unrealOpenDir && sameFolder(unrealOpenDir, p.path),
          pending: mine.length,
          clashes: mine.filter((q) => q.clash && !q.decision).length,
          ...(st?.running ? { running: true } : {}),
          ...(st?.lastAt ? { lastSync: st.lastAt } : {}),
          ...(st?.lastError && mine.length ? { problem: st.lastError } : {}),
          // The headless sync runs on the project Unreal last opened with the KesherAI Bridge plugin.
          canSync: current && mine.length > 0,
          page: "#/unreal",
        };
      }
      if (p.kind === "unity") {
        const mine = unityQ.filter((q) => sameFolder(q.project, p.path));
        const moves = await pendingMoves(p.path);
        const st = s.unity.syncState.get(p.path) ?? [...s.unity.syncState].find(([k]) => sameFolder(k, p.path))?.[1];
        const shown = !!s.unity.activeProject && sameFolder(s.unity.activeProject, p.path);
        return {
          ...base,
          open: (shown && s.unity.connected) || existsSync(join(p.path, "Temp", "UnityLockfile")),
          pending: mine.length + moves,
          ...(moves ? { moves } : {}),
          clashes: mine.filter((q) => q.clash && !q.decision).length,
          ...(st?.running ? { running: true } : {}),
          ...(st?.lastAt ? { lastSync: st.lastAt } : {}),
          ...(st?.lastError && mine.length ? { problem: st.lastError } : {}),
          // Scene moves go in when Unity opens (the package applies them); graph changes sync in a batch Unity run.
          canSync: mine.length > 0 && s.unity.hasProject(p.path),
          page: "#/unity",
        };
      }
      // Godot: the scene stand-in writes the .tscn at once, so nothing waits.
      return { ...base, open: !!godot.connected && !!godot.editor?.projectFile && sameFolder(dirname(godot.editor.projectFile), p.path), pending: 0, clashes: 0, canSync: false, page: "#/godot" };
    }));
    const order = { unity: 0, unreal: 1, godot: 2 } as const;
    projects.sort((a, b) => b.clashes - a.clashes || b.pending - a.pending || Number(b.open) - Number(a.open) || order[a.engine] - order[b.engine] || a.name.localeCompare(b.name));
    return { projects, clashes: projects.reduce((n, p) => n + p.clashes, 0) };
  });

  /** "Sync now" for one project: started in the background (it can take minutes); the page follows /api/games. */
  app.post<{ Body: { engine?: string; project?: string } }>("/api/games/sync", async (req, reply) => {
    const p = await findOne(req.body?.engine, req.body?.project);
    if (!p) return reply.code(400).send({ error: "Choose one of the projects found on this computer." });
    if (p.kind === "unreal") {
      const current = await s.unreal.project();
      if (!current || current.toLowerCase() !== p.name.toLowerCase()) return reply.code(409).send({ error: "Open this project in Unreal once (with the KesherAI Bridge plugin); after that it syncs with Unreal closed." });
      void s.unreal.syncNow().catch(() => undefined);
      return { started: true };
    }
    if (p.kind === "unity") {
      if (!s.unity.hasProject(p.path)) return reply.code(409).send({ error: "Add this project on the Unity page first." });
      void s.unity.syncNow(p.path).catch(() => undefined);
      return { started: true };
    }
    return reply.code(400).send({ error: "Godot projects have nothing waiting: the stand-in saves the scene at once." });
  });

  /** The clashes: both sides of each, and the choice made so far ("skip" ones stay listed). */
  app.get("/api/games/conflicts", async () => {
    const [uq, unityQ, unrealProject] = await Promise.all([s.unreal.queue(), s.unity.queue(), s.unreal.project()]);
    const list: Array<{ q: QueuedEdit; engine: "unreal" | "unity" }> = [
      ...uq.filter((q) => q.clash && q.decision !== "mine").map((q) => ({ q, engine: "unreal" as const })),
      ...unityQ.filter((q) => q.clash && q.decision !== "mine").map((q) => ({ q, engine: "unity" as const })),
    ];
    const unityWarm = list.some((c) => c.engine === "unity") ? await s.unity.editorReady().catch(() => false) : false;
    const conflicts: GameClash[] = [];
    for (const [i, { q, engine }] of list.entries()) {
      // The engine's side, read only from an open editor (never boots one) and for the first few.
      let now: BlueprintJson | undefined;
      if (i < 10 && q.baseSig) {
        if (engine === "unreal" && s.unreal.connected && q.project === unrealProject) now = (await s.unreal.graph(q.path).catch(() => undefined))?.graph;
        if (engine === "unity" && unityWarm && s.unity.activeProject && sameFolder(q.project, s.unity.activeProject)) now = (await s.unity.graph(q.path).catch(() => undefined))?.graph;
      }
      conflicts.push({
        id: q.id,
        engine,
        project: engine === "unity" ? basename(q.project) : q.project,
        key: q.project,
        path: q.path,
        name: shortName(q.path),
        ...(q.request ? { request: q.request } : {}),
        queuedAt: q.at,
        ...(q.baseAt ? { baseAt: q.baseAt } : {}),
        engineAt: q.clash!.engineAt,
        ...(q.decision ? { decision: q.decision } : {}),
        mine: opsSummary(q.ops, q.baseSig),
        ...(now && q.baseSig ? { diff: graphDiff(q.baseSig, now) } : {}),
      });
    }
    return { conflicts };
  });

  /** Roee's choice for one clash: keep mine (apply it now), keep the engine's (drop mine), or skip for now. */
  app.post<{ Params: { id: string }; Body: { choice?: string } }>("/api/games/conflicts/:id", async (req, reply) => {
    const choice = req.body?.choice;
    if (choice !== "mine" && choice !== "engine" && choice !== "skip") return reply.code(400).send({ error: "Choose mine, engine or skip." });
    const id = req.params.id;
    const done = (await s.unreal.decide(id, choice as ClashChoice)) || (await s.unity.decide(id, choice as ClashChoice));
    if (!done) return reply.code(404).send({ error: "That change is no longer waiting." });
    return { ok: true };
  });
}

/**
 * How many scene stand-in moves wait in a Unity project (KesherAI/pending-moves.json, applied by the package when
 * Unity opens).
 *
 * @param folder - The Unity project folder.
 */
async function pendingMoves(folder: string): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(join(folder, "KesherAI", "pending-moves.json"), "utf8")) as Record<string, unknown>;
    return Object.values(raw).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  } catch {
    return 0;
  }
}
