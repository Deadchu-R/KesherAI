import type { FastifyInstance } from "fastify";
import { projectFileInFolder } from "../project-path.js";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { KesherServices } from "../services.js";
import { findGameProjects, type GameProject } from "../game-projects.js";
import { gameSourceRoutes } from "./game-source.js";
import { HIT_KINDS, projectIndex, searchGameProject, type GameHit, type HitKind } from "../game-index.js";
import { cloudOnlyCount } from "../unreal-assets.js";
import { graphDiff, opsSummary, type ClashChoice, type SyncReport } from "../game-sync.js";
import { sameFolder } from "../unity-cli.js";
import { unityCapture } from "../unity-tools.js";
import { isLocalRequest } from "../auth.js";
import { editorOpen, runningUnity, type UnityProcesses } from "../unity-running.js";
import type { BlueprintJson, QueuedEdit } from "../unreal-bridge.js";
import { makeDiff } from "@kesher/agent";
import type { GameCheckpoint } from "../game-checkpoints.js";
import { ValueQueue } from "../game-inspector.js";
import { gameInspectorRoutes, syncValues, valueClashLines } from "./game-inspector.js";

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
  /** Inspector values waiting to be written (step 6). */
  values?: number;
  /** Queued changes that clash with an edit made in the engine (waiting for a choice). */
  clashes: number;
  running?: boolean;
  lastSync?: string;
  problem?: string;
  /** Unreal: packages only in OneDrive (not downloaded), skipped by the index. */
  cloudOnly?: number;
  /** Whether "Sync now" can run for it here. */
  canSync: boolean;
  /** Its page in the app. */
  page: string;
}

/** One clash on the Sync and conflicts sheet. */
export interface GameClash {
  id: string;
  engine: "unreal" | "unity" | "godot";
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
  /** An inspector value (step 6): the engine's side is the value in the file now. */
  value?: { engine: string[] };
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
  const name = r.engine === "unreal" ? r.project : basename(r.project);
  const app = r.engine === "unity" ? "Unity" : r.engine === "godot" ? "Godot" : "Unreal";
  if (r.clashes) return { title: `התנגשות בסנכרון · Sync clash: ${name}`, body: `${r.clashes} שינויים נערכו גם ב-${app}. בחר מה לשמור. · ${r.clashes} change(s) were also edited in ${app}. Choose what to keep.` };
  if (r.error) return { title: `הסנכרון נכשל · Sync failed: ${name}`, body: r.error };
  return undefined;
}

/**
 * The Game projects routes.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 * @param unityProcesses - The running Unity editors (tests give their own).
 */
export async function gamesRoutes(app: FastifyInstance, s: KesherServices, unityProcesses: () => Promise<UnityProcesses | undefined> = runningUnity): Promise<void> {
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
  // The Source view of every engine (step 4), on the same list of found projects.
  gameSourceRoutes(app, s, findOne);
  // The inspector with the engine closed (step 6): values queued here, written at the next sync.
  const values = new ValueQueue(s.paths.root);
  gameInspectorRoutes(app, s, findOne, values);
  const valuesOf = (all: Awaited<ReturnType<ValueQueue["list"]>>, p: GameProject) => all.filter((v) => v.engine === p.kind && sameFolder(v.project, p.path));

  // Unreal projects' index passes started by the list (at most one per project every few minutes), so the card can
  // show how many packages are only in OneDrive without waiting for a search.
  const indexedAt = new Map<string, number>();
  const refreshIndex = (root: string) => {
    if (Date.now() - (indexedAt.get(root) ?? 0) < 5 * 60_000) return;
    indexedAt.set(root, Date.now());
    void projectIndex(root).catch(() => undefined);
  };

  app.get("/api/games", async () => {
    const [list, uq, unityQ, unrealProject, vals] = await Promise.all([found(), s.unreal.queue(), s.unity.queue(), s.unreal.project(), values.list()]);
    const godot = s.godot.status();
        const projects: GameProjectState[] = await Promise.all(list.map(async (p): Promise<GameProjectState> => {
      const base = { engine: p.kind, name: p.name, path: p.path, ...(p.engine ? { version: p.engine } : {}) };
      if (p.kind === "unreal") {
        const mine = uq.filter((q) => q.project.toLowerCase() === p.name.toLowerCase());
        const current = !!unrealProject && unrealProject.toLowerCase() === p.name.toLowerCase();
        const st = current ? s.unreal.syncState : undefined;
        refreshIndex(p.path);
        const cloudOnly = cloudOnlyCount(p.path);
        return {
          ...base,
          open: s.unreal.connected && projectFileInFolder(s.unreal.projectFile, p.path),
          pending: mine.length,
          clashes: mine.filter((q) => q.clash && !q.decision).length,
          ...(st?.running ? { running: true } : {}),
          ...(st?.lastAt ? { lastSync: st.lastAt } : {}),
          ...(st?.lastError && mine.length ? { problem: st.lastError } : {}),
          ...(cloudOnly ? { cloudOnly } : {}),
          // The headless sync runs on the project Unreal last opened with the KesherAI Bridge plugin.
          canSync: current && mine.length > 0,
          page: "#/unreal",
        };
      }
      if (p.kind === "unity") {
        const mine = unityQ.filter((q) => sameFolder(q.project, p.path));
        const moves = await pendingMoves(p.path);
        const vs = valuesOf(vals, p);
        const st = s.unity.syncState.get(p.path) ?? [...s.unity.syncState].find(([k]) => sameFolder(k, p.path))?.[1];
        const shown = !!s.unity.activeProject && sameFolder(s.unity.activeProject, p.path);
        return {
          ...base,
          // A lock file alone can be left by a crash: it counts only with a running Unity for the project.
          open: (shown && s.unity.connected) || editorOpen(p.path, existsSync(join(p.path, "Temp", "UnityLockfile")), existsSync(join(p.path, "Temp", "UnityLockfile")) ? await unityProcesses() : undefined),
          pending: mine.length + moves + vs.length,
          ...(moves ? { moves } : {}),
          ...(vs.length ? { values: vs.length } : {}),
          clashes: mine.filter((q) => q.clash && !q.decision).length + vs.filter((v) => v.clash && !v.decision).length,
          ...(st?.running ? { running: true } : {}),
          ...(st?.lastAt ? { lastSync: st.lastAt } : {}),
          ...(st?.lastError && mine.length ? { problem: st.lastError } : {}),
          // Scene moves go in when Unity opens (the package applies them); graph changes sync in a batch Unity run.
          canSync: (mine.length > 0 && s.unity.hasProject(p.path)) || vs.length > 0,
          page: "#/unity",
        };
      }
      // Godot: the scene stand-in writes the .tscn at once; only inspector values wait.
      const vs = valuesOf(vals, p);
      return { ...base, open: !!godot.connected && !!godot.editor?.projectFile && sameFolder(dirname(godot.editor.projectFile), p.path), pending: vs.length, ...(vs.length ? { values: vs.length } : {}), clashes: vs.filter((v) => v.clash && !v.decision).length, canSync: vs.length > 0, page: "#/godot" };
    }));
    const order = { unity: 0, unreal: 1, godot: 2 } as const;
    projects.sort((a, b) => b.clashes - a.clashes || b.pending - a.pending || Number(b.open) - Number(a.open) || order[a.engine] - order[b.engine] || a.name.localeCompare(b.name));
    return { projects, clashes: projects.reduce((n, p) => n + p.clashes, 0) };
  });

  /**
   * "Draw a change" (Game projects, the phone too): a picture of the running game or editor view to mark up and send
   * as a change request. The engine's own view when it can give one (Godot: the editor's view through the bridge;
   * Unity: the Game or Scene view through the Pipeline CLI). The whole screen only for a request from this computer:
   * from the phone the screen goes through Remote control and its PIN, never through here.
   */
  app.post<{ Body: { engine?: string; project?: string; view?: string } }>("/api/games/screenshot", async (req, reply) => {
    const p = await findOne(req.body?.engine, req.body?.project);
    if (!p) return reply.code(400).send({ error: "Choose one of the projects found on this computer." });
    const view = req.body?.view === "scene" ? "scene" : "game";
    let png: Buffer | undefined;
    if (p.kind === "godot" && s.godot.status().connected) {
      png = await s.godot.request<{ png: string }>("screenshot", view === "scene" ? { view: "3d" } : {}, 20_000).then((r) => Buffer.from(r.png, "base64"), () => undefined);
    } else if (p.kind === "unity" && s.unity.hasProject(p.path)) {
      const dir = await mkdtemp(join(tmpdir(), "kesher-shot-"));
      png = await unityCapture(s.unity, p.path, view, join(dir, "view.png")).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    let source = "engine";
    if (!png && isLocalRequest(req) && s.screen) {
      png = await s.screen.shot().then((x) => x.png, () => undefined);
      source = "screen";
    }
    if (!png?.length) {
      const how = p.kind === "unreal" ? "Unreal gives no picture of its view to KesherAI yet" : `Open the project in ${p.kind === "unity" ? "Unity" : "Godot"} (with the KesherAI bridge) first`;
      return reply.code(409).send({ error: `${how}. On the phone, use Remote control's screen view and "Draw a change" there, or choose a photo.`, code: "no-shot" });
    }
    return reply.type("image/png").header("cache-control", "no-store").header("x-shot-source", source).send(png);
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
    // Inspector values first (written into the files with the engine closed), then the queued graph changes.
    const vs = valuesOf(await values.list(), p);
    let wrote: Awaited<ReturnType<typeof syncValues>> | undefined;
    if (vs.length) {
      wrote = await syncValues(s, values, p);
      if ("error" in wrote) {
        onSync({ engine: p.kind, project: p.path, applied: 0, failed: vs.length, clashes: 0, error: wrote.error });
        return reply.code(409).send({ error: wrote.error });
      }
      if (wrote.clashes || wrote.failed) onSync({ engine: p.kind, project: p.path, applied: wrote.applied, failed: wrote.failed, clashes: wrote.clashes, ...(wrote.failed ? { error: `${wrote.failed} value(s) could not be written; their files could not be read.` } : {}) });
    }
    const valuesDone = wrote && !("error" in wrote) ? { values: wrote } : {};
    if (p.kind === "unity") {
      const graphs = (await s.unity.queue()).some((q) => sameFolder(q.project, p.path));
      if (graphs && !s.unity.hasProject(p.path)) return reply.code(409).send({ error: "Add this project on the Unity page first.", ...valuesDone });
      if (graphs) void s.unity.syncNow(p.path).catch(() => undefined);
      return { started: graphs, ...valuesDone };
    }
    if (wrote) return { started: false, ...valuesDone };
    return reply.code(400).send({ error: "Nothing is waiting in this Godot project." });
  });

  /**
   * Search with the engine closed (step 3): classes and functions, scripts, scenes, prefabs and Blueprints, assets.
   * One project (engine + path, as listed) or, without one, every project found (at most 8, 20 results each).
   */
  app.get<{ Querystring: { engine?: string; project?: string; q?: string; kind?: string } }>("/api/games/search", async (req, reply) => {
    const q = String(req.query.q ?? "").slice(0, 200);
    const kind = (HIT_KINDS as readonly string[]).includes(String(req.query.kind)) ? (req.query.kind as HitKind) : undefined;
    let list: GameProject[];
    if (req.query.project) {
      const p = await findOne(req.query.engine, req.query.project);
      if (!p) return reply.code(400).send({ error: "Choose one of the projects found on this computer." });
      list = [p];
    } else list = (await found()).slice(0, 8);
    const results: Array<{ engine: GameProject["kind"]; name: string; path: string; hits: GameHit[]; counts: Record<HitKind, number> }> = [];
    for (const p of list) {
      const r = await searchGameProject(p.path, q, { ...(kind ? { kind } : {}), limit: list.length > 1 ? 20 : 80 });
      if (list.length === 1 || r.hits.length) results.push({ engine: p.kind, name: p.name, path: p.path, hits: r.hits, counts: r.counts });
    }
    return { results };
  });

  // Checkpoints around engine writes (step 5): list, compare, restore, and how much is kept.
  const cpView = (c: GameCheckpoint) => ({ id: c.id, engine: c.engine, name: c.name, project: c.project, source: c.source, label: c.label, at: c.at, ...(c.chatId ? { chatId: c.chatId } : {}), files: c.files.map((f) => ({ rel: f.rel, size: f.size, ...(f.blob ? {} : { added: true }), ...(f.skipped ? { skipped: true } : {}) })) });
  app.get<{ Querystring: { engine?: string; project?: string } }>("/api/games/checkpoints", async (req, reply) => {
    let project: string | undefined;
    if (req.query.project) {
      const p = await findOne(req.query.engine, req.query.project);
      if (!p) return reply.code(400).send({ error: "Choose one of the projects found on this computer." });
      project = p.path;
    }
    const [list, usage] = await Promise.all([s.gameCheckpoints.list(project), s.gameCheckpoints.usage()]);
    return { checkpoints: list.slice(0, 200).map(cpView), bytes: usage.bytes, count: usage.checkpoints, limits: s.config.gameCheckpoints };
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/games/checkpoints/:id/diff", async (req, reply) => {
    try {
      const c = await s.gameCheckpoints.compare(req.params.id, String(req.query.path ?? ""));
      if (c.binary) return { rel: c.rel, binary: true, sizeBefore: c.sizeBefore, sizeNow: c.sizeNow };
      // From the kept file to the file now: what changed since the checkpoint.
      return { rel: c.rel, binary: false, sizeBefore: c.sizeBefore, sizeNow: c.sizeNow, diff: makeDiff(c.rel, c.before, c.now ?? "").slice(0, 200_000) };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/games/checkpoints/:id/restore", async (req, reply) => {
    const cp = await s.gameCheckpoints.get(req.params.id);
    if (!cp) return reply.code(404).send({ error: "No such checkpoint." });
    // Unreal holds its packages while open and would save its own copy over them.
    const unrealOpen = s.unreal.connected && !!s.unreal.projectFile && projectFileInFolder(s.unreal.projectFile, cp.project);
    if (unrealOpen && cp.files.some((f) => /\.(uasset|umap)$/i.test(f.rel))) return reply.code(409).send({ error: "Close Unreal first: it keeps these assets open and would save over them." });
    try {
      const r = await s.gameCheckpoints.restore(cp.id);
      return { restored: r.restored, skipped: r.skipped, ...(r.before ? { before: r.before.id } : {}) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** How long and how much the store keeps; saving prunes at once. */
  app.put<{ Body: { days?: number; maxMB?: number } }>("/api/games/checkpoints/settings", async (req, reply) => {
    const days = Math.round(Number(req.body?.days));
    const maxMB = Math.round(Number(req.body?.maxMB));
    if (!(days >= 1 && days <= 3650) || !(maxMB >= 50 && maxMB <= 1_000_000)) return reply.code(400).send({ error: "Days 1-3650, size 50 MB or more." });
    s.config.gameCheckpoints = { days, maxMB };
    await s.saveConfig();
    const r = await s.gameCheckpoints.prune();
    return { removed: r.removed, bytes: r.bytes, limits: s.config.gameCheckpoints };
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
    for (const v of await values.list()) {
      if (!v.clash || v.decision === "mine") continue;
      const lines = valueClashLines(v);
      conflicts.push({ id: v.id, engine: v.engine, project: basename(v.project), key: v.project, path: v.file, name: `${shortName(v.file)} · ${v.object}`, queuedAt: v.at, engineAt: v.clash.at, ...(v.decision ? { decision: v.decision } : {}), mine: lines.mine, value: { engine: lines.engine } });
    }
    return { conflicts };
  });

  /** Roee's choice for one clash: keep mine (apply it now), keep the engine's (drop mine), or skip for now. */
  app.post<{ Params: { id: string }; Body: { choice?: string } }>("/api/games/conflicts/:id", async (req, reply) => {
    const choice = req.body?.choice;
    if (choice !== "mine" && choice !== "engine" && choice !== "skip") return reply.code(400).send({ error: "Choose mine, engine or skip." });
    const id = req.params.id;
    const done = (await s.unreal.decide(id, choice as ClashChoice)) || (await s.unity.decide(id, choice as ClashChoice)) || (await values.decide(id, choice as ClashChoice));
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
