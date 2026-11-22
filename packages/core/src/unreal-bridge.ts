import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type WebSocket from "ws";
import { batchFiles, engineChangedAt, nodeSig, sortForSync, unrealAssetFile, unrealLevelFile, type ClashChoice, type SyncBatch, type SyncReport } from "./game-sync.js";
import { mergeEdits, withTempIds } from "./unity-cli.js";
import { applyBpOps, bpNodeTemplate, COMMON_BP_ACTIONS, diffBpGraphs, mapCompileMessages, searchBpActions, type BpAction, type BpCompileMessage, type BpDiff, type BpDoc, type BpOp, type BpResult } from "@kesher/shared";

/**
 * The link to the Unreal Editor (the KesherAI Bridge plugin,
 * integrations/unreal/KesherAIBridge).
 *
 * The editor connects to KesherAI (never the other way round) and answers
 * commands: list, graph, apply, compile, save, open. KesherAI keeps a copy
 * of every Blueprint it has read, per project, so they can be looked at with
 * Unreal closed; changes asked for then wait in a queue and are applied when
 * the editor connects again.
 */

/** The plugin version this KesherAI ships (integrations/unreal/KesherAIBridge). */
export const BRIDGE_VERSION = "0.1.33";

/** What the editor said when it connected. */
export interface EditorInfo {
  project: string;
  engine: string;
  bridge: string;
  /** The project's .uproject on this computer (plugin 0.1.3+). */
  projectFile?: string;
  /** The editor's process (plugin 0.1.4+). */
  pid?: number;
  connectedAt: string;
}

/** A change waiting for the editor. */
export interface QueuedEdit {
  id: string;
  project: string;
  path: string;
  graph: string;
  ops: unknown[];
  /** What the user asked for, in words. */
  request?: string;
  /**
   * "create": make this Blueprint first (it was made in KesherAI with Unreal closed). "material": a material for a
   * level actor's mesh slot (unreal_apply_material with Unreal closed): `path` is the level, `ops` has one
   * { op: "material", actor, component, slot, material }. "spawn": actors placed in a level by the Level design
   * specialist (unreal_blockout): `path` is the level, `ops` the actors for `level_spawn`. "vfx": a Niagara system
   * made by the VFX specialist (unreal_vfx): `path` is the new asset, `ops` has one spec for `vfx_create`.
   */
  kind?: "create" | "material" | "spawn" | "vfx";
  /** For "create": the parent class (Actor, Pawn, Character, GameModeBase, PlayerController, ActorComponent, UserWidget…). */
  parent?: string;
  at: string;
  /** When the saved copy this change was made on was read from the engine (for the clash check; game-sync.ts). */
  baseAt?: string;
  /** That copy's nodes (id → title), to show what the engine changed when they clash. */
  baseSig?: Record<string, string>;
  /** Set when the engine saved the graph after that copy: the change waits for Roee's choice. */
  clash?: { engineAt: string };
  /** The choice made for a clash: "mine" applies it anyway, "skip" keeps it waiting without syncing it. */
  decision?: "mine" | "skip";
}

/** A Blueprint's last compile through KesherAI: whether it passed, and its messages tied to nodes. */
export interface CompileRecord { ok: boolean; at: string; messages: BpCompileMessage[] }

/** What the Unreal page shows about the connection. */
export interface BridgeStatus {
  connected: boolean;
  editor?: EditorInfo;
  /** Projects with Blueprints saved here (for working with Unreal closed). */
  projects: string[];
  queued: number;
  /** When a Blueprint last compiled in the editor (ms since 1970). */
  changedAt?: number;
  /** With the editor closed, commands run in a headless editor (the KesherBridge commandlet, plugin 0.1.13+). */
  offline?: boolean;
}

/** One answer of the headless editor. */
export interface HeadlessAnswer {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Commands the headless editor (the editor closed) can run. */
const OFFLINE_COMMANDS = new Set(["list", "graph", "apply", "vars", "compile", "save", "actions", "widget", "create", "import_texture", "widget_apply", "levels", "level", "level_mesh", "level_move", "level_material", "level_spawn", "vfx_create", "asset_export", "asset_import"]);

/** A stand-in answer kept on disk, unless it is an empty level list (a scan that was not ready, kept by 0.6.383). */
const usable = <T>(cmd: string, v: T | undefined): T | undefined => (cmd === "levels" && v && !(v as { levels?: unknown[] }).levels?.length ? undefined : v);

/** Commands that only read: no "changed" after them. */
const READ_ONLY = new Set(["list", "graph", "actions", "widget", "levels", "level", "level_mesh", "asset_export"]);

const slug = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 80) || "project";
const fileFor = (path: string) => `${createHash("sha256").update(path).digest("hex").slice(0, 24)}.json`;
/** The file a queued change writes: a level's .umap for a material or placed actors, else the asset's .uasset. */
const queuedFile = (dir: string, q: QueuedEdit) => (q.kind === "material" || q.kind === "spawn" ? unrealLevelFile(dir, q.path) : unrealAssetFile(dir, q.path));
/** Queued changes that are one bridge command of their own (not a Blueprint graph's ops). */
const ownCommand = (q: QueuedEdit) => q.kind === "material" || q.kind === "spawn" || q.kind === "vfx";
/** Graph changes the headless editor cannot make (Collapse to Function needs the open Blueprint editor). */
const needsEditor = (q: QueuedEdit) => !q.kind && q.ops.some((o) => (o as { op?: unknown })?.op === "collapse");
/**
 * The bridge command of a queued material, placement or effect.
 *
 * @param q - The queued change (`ownCommand` is true for it).
 * @returns The command with its arguments.
 */
function queuedCommand(q: QueuedEdit): Record<string, unknown> {
  if (q.kind === "spawn") return { cmd: "level_spawn", path: q.path, actors: q.ops };
  if (q.kind === "vfx") return { ...((q.ops[0] ?? {}) as Record<string, unknown>), cmd: "vfx_create", path: q.path };
  return { cmd: "level_material", path: q.path, ...materialArgs(q) };
}
/** A queued material change's arguments for the `level_material` command. */
function materialArgs(q: QueuedEdit): Record<string, string> {
  const o = (q.ops[0] ?? {}) as Record<string, unknown>;
  return { actor: String(o.actor ?? ""), component: String(o.component ?? ""), slot: String(o.slot ?? "0"), material: String(o.material ?? "") };
}

/** The bridge. One per server. */
export class UnrealBridge {
  private socket?: WebSocket;
  private info?: EditorInfo;
  private readonly waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(event: string) => void>();
  private inPlay = false;
  /** The project shown when the editor is closed: the last one that connected. */
  private lastProject?: string;
  /** Its .uproject (for the headless editor). */
  private lastProjectFile?: string;
  /** Runs commands in a headless editor (UnrealEditor-Cmd -run=KesherBridge); set by the server. */
  private headless?: (projectFile: string, commands: Array<Record<string, unknown>>) => Promise<HeadlessAnswer[]>;
  /** One headless editor at a time. */
  private headlessChain: Promise<unknown> = Promise.resolve();

  /**
   * Lets commands run with the editor closed (asked for: "everything works offline").
   *
   * @param run - Starts a headless editor on the project with these commands and returns its answers.
   */
  setHeadless(run: (projectFile: string, commands: Array<Record<string, unknown>>) => Promise<HeadlessAnswer[]>): void {
    this.headless = run;
    void this.project().catch(() => undefined);
  }

  /** Whether commands can run now: the editor is connected, or it is closed and a headless editor can run them. */
  get available(): boolean {
    return this.connected || (!!this.headless && !!this.lastProjectFile && existsSync(this.lastProjectFile));
  }

  /**
   * Runs commands in one headless editor start (30-90 s), the editor being closed.
   *
   * @param commands - { cmd, ...args } each.
   * @returns Their answers, in order.
   */
  async offline(commands: Array<Record<string, unknown>>, projectFile?: string): Promise<HeadlessAnswer[]> {
    await this.project();
    // Another project than the last one (the stand-in's projects menu): its own headless editor.
    const file = projectFile ?? this.lastProjectFile;
    if (!this.headless || !file || !existsSync(file)) throw new Error(`The ${this.editor} is closed and KesherAI does not know the project yet: open it once with the KesherAI Bridge plugin.`);
    const run = this.headlessChain.then(() => this.headless!(file, commands));
    this.headlessChain = run.catch(() => undefined);
    const answers = await run;
    if (commands.some((c) => !READ_ONLY.has(String(c.cmd)))) {
      this.changedAt = Date.now();
      this.emit("changed");
    }
    return answers;
  }

  /** Runs a gameplay test in a headless editor (Unreal's automation runner); set by the server. */
  private headlessPlay?: (projectFile: string, plan: unknown) => Promise<unknown>;

  /**
   * Lets gameplay tests run with the editor closed (plugin 0.1.25+: the automation test KesherAI.PlayTest.Request).
   *
   * @param run - Starts a headless editor on the project with the plan and returns the plugin's end state.
   */
  setHeadlessPlay(run: (projectFile: string, plan: unknown) => Promise<unknown>): void {
    this.headlessPlay = run;
  }

  /** Whether a gameplay test can run with the editor closed (the project is known and a runner is set). */
  get canPlayHeadless(): boolean {
    return !!this.headlessPlay && !!this.lastProjectFile && existsSync(this.lastProjectFile);
  }

  /**
   * Runs a gameplay test headless on a given project (the night builds' smoke test), in the same one-at-a-time chain.
   *
   * @param file - The project's .uproject.
   * @param plan - The checked plan (play-test.ts).
   * @returns The plugin's end state.
   */
  async playHeadlessFor(file: string, plan: unknown): Promise<unknown> {
    if (!this.headlessPlay || !existsSync(file)) throw new Error("Gameplay tests cannot run with Unreal closed here.");
    const run = this.headlessChain.then(() => this.headlessPlay!(file, plan));
    this.headlessChain = run.catch(() => undefined);
    return run;
  }

  /** The project file in use: the connected editor's, else the last one that connected. */
  get knownProjectFile(): string | undefined {
    return this.projectFile ?? this.lastProjectFile;
  }

  /**
   * Runs a gameplay test in a headless editor, the editor being closed (one headless editor at a time).
   *
   * @param plan - The checked plan (play-test.ts).
   * @returns The plugin's end state: steps, log, passed.
   */
  async playHeadless(plan: unknown): Promise<unknown> {
    await this.project();
    const file = this.lastProjectFile;
    if (!this.headlessPlay || !file || !existsSync(file)) throw new Error(`The ${this.editor} is closed and KesherAI does not know the project yet: open it once with the KesherAI Bridge plugin.`);
    const run = this.headlessChain.then(() => this.headlessPlay!(file, plan));
    this.headlessChain = run.catch(() => undefined);
    return run;
  }

  /**
   * @param dir - Folder for saved graphs and the queue (`<data>/unreal`, `<data>/unity`).
   * @param editor - The editor's name in messages ("Unreal Editor", "Unity Editor").
   */
  constructor(
    private readonly dir: string,
    private readonly editor = "Unreal Editor",
  ) {}

  /** @returns The connected editor's project file, when the plugin said it. */
  get projectFile(): string | undefined {
    return this.connected ? this.info?.projectFile : undefined;
  }

  /**
   * Asks the connected editor to close for the plugin's update (it offers to
   * save first) and waits until it has closed. An older plugin without that
   * command: waits for the user to close Unreal.
   *
   * @param timeoutMs - How long to wait for it to close.
   * @throws Error when the user cancelled the save, or it did not close in time.
   */
  async closeForUpdate(timeoutMs = 15 * 60_000): Promise<void> {
    const pid = this.info?.pid;
    if (this.connected) {
      const r = await this.request<{ ok?: boolean; manual?: boolean }>("quit_for_update", {}, 10 * 60_000).catch((err: Error) => (/Unknown command/.test(err.message) ? { ok: true, manual: true } : Promise.reject(err)));
      if (r.ok === false) throw new Error("Unreal stayed open (saving was cancelled). Press Update again when ready.");
      // An older plugin cannot close Unreal: wait (up to half a day) for the user to close it; the update then finishes by itself.
      if (r.manual) timeoutMs = Math.max(timeoutMs, 12 * 3600_000);
    }
    const alive = () => {
      if (!pid) return this.connected;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const until = Date.now() + timeoutMs;
    while (alive() || this.connected) {
      if (Date.now() > until) throw new Error("Unreal did not close. Close it, then press Update again.");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /**
   * Closes the open editor from KesherAI (plugin 0.1.18+), with the choice already made: save everything
   * first, or throw unsaved changes away. Unreal asks nothing. Waits (up to a minute) until it has closed.
   *
   * @param save - Save all unsaved files first.
   * @returns Whether it saved.
   */
  async closeEditor(save: boolean): Promise<{ closed: true; saved: boolean }> {
    if (!this.connected) throw Object.assign(new Error("Unreal is not open (or its KesherAI plugin is not connected)."), { code: 409 });
    const pid = this.info?.pid;
    await this.request("close_editor", { save }, 10 * 60_000).catch((err: Error) => {
      throw /Unknown command/.test(err.message) ? Object.assign(new Error(`Closing from KesherAI needs the KesherAI plugin ${BRIDGE_VERSION}. Update it on this page, or close Unreal yourself.`), { code: 409 }) : err;
    });
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      let alive: boolean = this.connected;
      if (pid) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (!alive) return { closed: true, saved: save };
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("Unreal was asked to close but is still open. Look at its window.");
  }

  /** @returns Whether an editor is connected now. */
  get connected(): boolean {
    return !!this.socket && this.socket.readyState === 1 && !!this.info;
  }

  /** @returns The project the page should show: the connected one, else the last one. */
  async project(): Promise<string | undefined> {
    if (this.info) return this.info.project;
    if (this.lastProject) return this.lastProject;
    const meta = await this.readJson<{ last?: string; projectFile?: string }>(join(this.dir, "last.json"));
    if (meta?.projectFile && /\.uproject$/i.test(meta.projectFile)) this.lastProjectFile = meta.projectFile;
    else if (meta?.last && /unreal/i.test(this.editor)) {
      // Saved by an older plugin (the name only): find its .uproject among the projects on this computer, so the
      // headless editor can run with Unreal closed (found on the PC: "Unreal not connected" with Unreal closed).
      const { findGameProjects } = await import("./game-projects.js");
      const found = (await findGameProjects().catch(() => [])).find((g) => g.kind === "unreal" && g.name.toLowerCase() === meta.last!.toLowerCase());
      const file = found ? await uprojectIn(found.path) : undefined;
      if (file) {
        this.lastProjectFile = file;
        await writeFile(join(this.dir, "last.json"), JSON.stringify({ last: meta.last, projectFile: file })).catch(() => undefined);
      }
    }
    return (this.lastProject = meta?.last);
  }

  /**
   * Calls back on "connected", "disconnected" and "changed" (a Blueprint compiled in the editor).
   *
   * @param fn - The listener.
   * @returns A function that removes it.
   */
  on(fn: (event: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Whether the editor is in Play (PIE) now; false for a plugin older than 0.1.29, which never says. */
  get playing(): boolean {
    return this.inPlay;
  }

  private emit(event: string): void {
    for (const fn of this.listeners) fn(event);
  }

  /**
   * Takes a new connection from the editor (a newer one replaces an older one).
   *
   * @param socket - The WebSocket.
   */
  attach(socket: WebSocket): void {
    this.socket?.close();
    this.socket = socket;
    this.info = undefined;
    socket.on("message", (data) => void this.onMessage(socket, String(data)));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.info = undefined;
      this.inPlay = false;
      for (const [id, w] of this.waiting) {
        clearTimeout(w.timer);
        w.reject(new Error(`The ${this.editor} disconnected.`));
        this.waiting.delete(id);
      }
      this.emit("disconnected");
    });
  }

  private async onMessage(socket: WebSocket, text: string): Promise<void> {
    let msg: { id?: string; ok?: boolean; result?: unknown; error?: string; event?: string; on?: boolean; project?: string; engine?: string; bridge?: string; projectFile?: string; pid?: number };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (msg.event === "hello" && socket === this.socket) {
      // Only a real .uproject on this computer is kept (the chat's Unreal tools then work on that project).
      const pf = typeof msg.projectFile === "string" && /\.uproject$/i.test(msg.projectFile) && existsSync(msg.projectFile) ? msg.projectFile : undefined;
      const pid = typeof msg.pid === "number" && Number.isInteger(msg.pid) && msg.pid > 0 ? msg.pid : undefined;
      const info = { project: String(msg.project ?? "Project"), engine: String(msg.engine ?? ""), bridge: String(msg.bridge ?? ""), ...(pf ? { projectFile: pf } : {}), ...(pid ? { pid } : {}), connectedAt: new Date().toISOString() };
      this.info = info;
      this.lastProject = info.project;
      if (pf) this.lastProjectFile = pf;
      // `info`, not this.info, after the awaits: the editor may disconnect meanwhile (this.info is cleared then; seen in CI).
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, "last.json"), JSON.stringify({ last: info.project, ...(this.lastProjectFile ? { projectFile: this.lastProjectFile } : {}) }));
      if (socket !== this.socket) return;
      this.emit("connected");
      void this.afterConnect().catch(() => undefined);
      return;
    }
    if (msg.event === "play" && socket === this.socket) {
      // Play In Editor started or ended (plugin 0.1.29 and newer): KesherAI frees the graphics card meanwhile (play-standby.ts).
      this.inPlay = msg.on === true;
      return this.emit("play");
    }
    if (msg.event === "changed") {
      // A Blueprint compiled in the editor: the page reads its graph again at once (it sees the time in status).
      this.changedAt = Date.now();
      return this.emit("changed");
    }
    const w = msg.id ? this.waiting.get(msg.id) : undefined;
    if (!w || !msg.id) return;
    this.waiting.delete(msg.id);
    clearTimeout(w.timer);
    if (msg.ok) w.resolve(msg.result);
    else w.reject(new Error(msg.error ?? `The ${this.editor} could not do that.`));
  }

  /** Saves the list of Blueprints, then applies changes that waited for the editor. */
  private async afterConnect(): Promise<void> {
    await this.list();
    const project = this.info?.project;
    if (!project) return;
    const { apply, newClashes } = await this.sortMine(project);
    await this.checkpoint(project, apply);
    let applied = 0;
    let failed = 0;
    // A graph's waiting changes go in one apply (the ids of nodes added with Unreal closed are refs within it).
    for (const group of mergeEdits(apply)) {
      const q = group.edits[0]!;
      if (!q.kind) {
        try {
          await this.request("apply", { path: group.path, graph: group.graph, ops: group.ops });
          const answer = await this.request("compile", { path: group.path }, 120_000).catch(() => undefined);
          for (const e of group.edits) await this.unqueue(e.id);
          const read = await this.graph(group.path).catch(() => undefined);
          if (answer) await this.recordCompile(group.path, answer, read?.graph).catch(() => undefined);
          applied += group.edits.length;
        } catch {
          failed += group.edits.length;
        }
        continue;
      }
      try {
        // A Blueprint made in KesherAI while Unreal was closed: made now, before the changes that follow it in the queue.
        if (ownCommand(q)) {
          const { cmd, ...args } = queuedCommand(q);
          await this.request(String(cmd), args, 120_000);
          await this.unqueue(q.id);
          applied++;
          continue;
        }
        if (q.kind === "create") {
          await this.request("create", { path: q.path, parent: q.parent ?? "Actor" }, 60_000);
          await this.unqueue(q.id);
          await this.list().catch(() => undefined);
          applied++;
          continue;
        }
      } catch {
        // stays queued; the page shows it
        failed++;
      }
    }
    if (apply.length || newClashes.length) this.onSync?.({ engine: "unreal", project, applied, failed, clashes: newClashes.length, ...(failed ? { error: `${failed} change(s) could not be applied; they stay waiting.` } : {}) });
  }

  /** Called when a sync ends (the Game projects page sends a notification on a failure or a clash). */
  onSync?: (r: SyncReport) => void;
  /** Called before a batch of queued changes is applied, to keep their files first (a checkpoint). */
  beforeSync?: (b: SyncBatch) => Promise<void>;

  /** Keeps the files a batch will write (a failed checkpoint never stops the sync). */
  private async checkpoint(project: string, edits: QueuedEdit[]): Promise<void> {
    const file = this.lastProjectFile ?? this.info?.projectFile;
    if (!edits.length || !file || !this.beforeSync) return;
    const dir = dirname(file);
    const files = batchFiles(edits, (q) => queuedFile(dir, q));
    if (files.length) await this.beforeSync({ engine: "unreal", project: dir, name: project, files, count: edits.length }).catch(() => undefined);
  }

  /**
   * A project's queued changes, split by the clash check (game-sync.ts): new clashes are marked in the queue.
   *
   * @param project - The project's name.
   * @returns The changes to apply now, and the ones newly found clashing.
   */
  private async sortMine(project: string): Promise<{ apply: QueuedEdit[]; newClashes: QueuedEdit[] }> {
    const all = await this.queue();
    const file = this.lastProjectFile ?? this.info?.projectFile;
    const dir = file ? dirname(file) : undefined;
    const r = await sortForSync(all.filter((q) => q.project === project), (q) => (dir ? queuedFile(dir, q) : undefined));
    if (r.newClashes.length) await this.writeJson(join(this.dir, "queue.json"), all);
    return r;
  }

  /**
   * Roee's choice for a queued change that clashes with an edit made in Unreal: "mine" applies it anyway (at the next
   * sync, started now), "engine" drops it (Unreal's version stays), "skip" leaves it waiting without syncing it.
   *
   * @param id - The queued change.
   * @param choice - The choice.
   * @returns Whether the change was there.
   */
  async decide(id: string, choice: ClashChoice): Promise<boolean> {
    const all = await this.queue();
    const q = all.find((x) => x.id === id);
    if (!q) return false;
    if (choice === "engine") {
      await this.unqueue(id);
      if (this.connected) await this.graph(q.path).catch(() => undefined);
      return true;
    }
    q.decision = choice;
    await this.writeJson(join(this.dir, "queue.json"), all);
    if (choice === "mine") this.scheduleSync(500);
    return true;
  }

  /**
   * Sends a command to the editor.
   *
   * @param cmd - list, graph, apply, compile, save, open or ping.
   * @param args - Its arguments.
   * @param timeoutMs - How long to wait.
   * @returns The editor's answer.
   * @throws Error when no editor is connected, it fails, or it does not answer in time.
   */
  request<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const socket = this.socket;
    if (!socket || !this.connected) {
      // The editor is closed: a headless editor runs it (slower), instead of "not connected".
      if (this.headless && OFFLINE_COMMANDS.has(cmd))
        return this.offline([{ cmd, ...args }]).then(([a]) => (a?.ok ? (a.result as T) : Promise.reject(new Error(a?.error ?? `The ${this.editor} could not do that.`))));
      return Promise.reject(new Error(`The ${this.editor} is not connected. Open your project with the KesherAI Bridge plugin.`));
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`The ${this.editor} did not answer in time.`));
      }, timeoutMs);
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ id, cmd, ...args }));
    });
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  }

  private projectDir(project: string): string {
    return join(this.dir, slug(project));
  }

  /**
   * The stand-in's read (a level, its levels, a mesh): from the editor when it is open (and kept here), else the copy
   * kept, else a headless editor (slow, once: it is kept after).
   *
   * @param cmd - levels, level or level_mesh.
   * @param path - The level or mesh ("" for levels).
   * @param projectFile - A project chosen from the menu (its .uproject), when not the one open.
   * @returns The answer, and whether it came from the copy kept.
   */
  async standIn<T extends object>(cmd: "levels" | "level" | "level_mesh", path = "", projectFile?: string): Promise<T & { cached?: boolean }> {
    // A project chosen from the menu that is not the one open in the editor: read headless from its own .uproject.
    const other = !!projectFile && !(this.connected && this.lastProjectFile && resolve(this.lastProjectFile).toLowerCase() === resolve(projectFile).toLowerCase());
    const project = other ? basename(projectFile!, ".uproject") : await this.project();
    if (!project) throw new Error(`KesherAI does not know the project yet: open it once in the ${this.editor} with the KesherAI Bridge plugin.`);
    const file = join(this.projectDir(project), "standin", `${cmd}-${fileFor(path)}`);
    if (other) {
      const kept = usable(cmd, await this.readJson<T>(file));
      if (kept) return { ...kept, cached: true };
      const [a] = await this.offline([{ cmd, path }], projectFile);
      if (!a?.ok) throw new Error(a?.error ?? `The ${this.editor} could not do that.`);
      const answer = a.result as T;
      if (!(cmd === "levels" && !(answer as { levels?: unknown[] }).levels?.length)) await this.writeJson(file, answer);
      return answer;
    }
    if (this.connected) {
      try {
        const live = await this.request<T>(cmd, { path }, 120_000);
        if (!(cmd === "levels" && !(live as { levels?: unknown[] }).levels?.length)) await this.writeJson(file, live);
        return live as T;
      } catch (e) {
        const kept = usable(cmd, await this.readJson<T>(file));
        if (kept) return { ...kept, cached: true };
        throw e;
      }
    }
    const kept = usable(cmd, await this.readJson<T>(file));
    if (kept) return { ...kept, cached: true };
    const answer = await this.request<T>(cmd, { path }, 900_000);
    // An empty list is not kept (a scan that was not ready would stick): the next read asks again.
    if (!(cmd === "levels" && !(answer as { levels?: unknown[] }).levels?.length)) await this.writeJson(file, answer);
    return answer as T;
  }

  /**
   * The editors' "Open from project" (plugin 0.1.33+): an asset exported to a file (asset_export: a mesh as FBX, a
   * texture as PNG, a sound as WAV) or an edited file imported over an asset (asset_import, saved). In the open editor
   * when it has this project, else in a headless one on the project's .uproject.
   *
   * @param cmd - asset_export or asset_import.
   * @param args - { path: "/Game/…", file, name? } (files under the project's Saved/KesherAI/).
   * @param projectFile - The project's .uproject.
   * @returns The plugin's answer.
   */
  async assetCommand<T = unknown>(cmd: "asset_export" | "asset_import", args: Record<string, unknown>, projectFile: string): Promise<T> {
    const open = this.connected && !!this.lastProjectFile && resolve(this.lastProjectFile).toLowerCase() === resolve(projectFile).toLowerCase();
    if (open) return this.request<T>(cmd, args, 900_000);
    const [a] = await this.offline([{ cmd, ...args }], projectFile);
    if (!a?.ok) throw new Error(a?.error ?? `The ${this.editor} could not do that.`);
    return a.result as T;
  }

  /**
   * The stand-in's moves into the level: in the open editor as one undo step (left for her to save), or with it closed
   * in a headless editor that saves the level.
   *
   * @param path - The level.
   * @param moves - { id, from: {position, rotation}, to: {position, rotation, scale} } each, in Unreal's units.
   * @returns How many moved, and those that moved in Unreal meanwhile (left as they are) or are gone.
   */
  async moveActors(path: string, moves: unknown[], projectFile?: string): Promise<{ moved: number; clashes: string[]; missing: string[]; saved: boolean }> {
    const other = !!projectFile && !(this.connected && this.lastProjectFile && resolve(this.lastProjectFile).toLowerCase() === resolve(projectFile).toLowerCase());
    type Moved = { moved: number; clashes: string[]; missing: string[]; saved: boolean };
    let r: Moved;
    if (other) {
      const [a] = await this.offline([{ cmd: "level_move", path, moves }], projectFile);
      if (!a?.ok) throw new Error(a?.error ?? `The ${this.editor} could not do that.`);
      r = a.result as Moved;
    } else r = await this.request<Moved>("level_move", { path, moves }, 900_000);
    // The copy kept is now old: the next read takes the level again.
    const project = other ? basename(projectFile!, ".uproject") : await this.project();
    if (project) await rm(join(this.projectDir(project), "standin", `level-${fileFor(path)}`), { force: true }).catch(() => undefined);
    return r;
  }

  /**
   * The stand-in's copy of a read kept here, without asking any editor (fast: for approval cards).
   *
   * @param cmd - levels or level.
   * @param path - The level ("" for levels).
   * @returns The copy, or undefined when none is kept.
   */
  async keptStandIn<T extends object>(cmd: "levels" | "level", path = ""): Promise<T | undefined> {
    const project = await this.project();
    return project ? usable(cmd, await this.readJson<T>(join(this.projectDir(project), "standin", `${cmd}-${fileFor(path)}`))) : undefined;
  }

  /**
   * A material in one slot of a level actor's mesh (unreal_apply_material), in the open editor as one undo step (left
   * for her to save). The kept copy of the level is dropped, so the next read shows the new material.
   *
   * @param path - The level (/Game/…).
   * @param args - The actor (label or id), mesh component ("" = the first), slot (index or name) and material path.
   * @returns What the editor did: the actor, component, slot index, the old and new material, and whether it saved.
   */
  async applyMaterial(path: string, args: { actor: string; component: string; slot: string; material: string }): Promise<{ actor: string; component: string; slot: number; from: string; to: string; saved: boolean }> {
    const r = await this.request<{ actor: string; component: string; slot: number; from: string; to: string; saved: boolean }>("level_material", { path, ...args }, 120_000);
    const project = await this.project();
    if (project) await rm(join(this.projectDir(project), "standin", `level-${fileFor(path)}`), { force: true }).catch(() => undefined);
    return r;
  }

  /**
   * The project's Blueprints: from the editor when it is connected (and saved here), else the saved list.
   *
   * @returns The list, and whether it came from the saved copy.
   */
  async list(): Promise<{ blueprints: Array<{ path: string; name: string; parent?: string; saved?: boolean }>; offline: boolean; project?: string }> {
    const project = await this.project();
    if (!project) return { blueprints: [], offline: true };
    const file = join(this.projectDir(project), "list.json");
    let offline = !this.connected;
    let list: { blueprints: Array<{ path: string; name: string; parent?: string }> } | undefined;
    if (!offline) {
      try {
        list = await this.request<typeof list>("list");
        await this.writeJson(file, list);
      } catch {
        offline = true;
      }
    }
    list ??= await this.readJson<typeof list>(file);
    if (!list && this.available) {
      try {
        list = await this.request<typeof list>("list", {}, 900_000);
        await this.writeJson(file, list);
      } catch {
        /* the saved one (none) */
      }
    }
    list ??= { blueprints: [] };
    // Blueprints made in KesherAI that wait for Unreal: listed (and editable) already.
    for (const q of await this.queue()) {
      if (q.kind === "create" && q.project === project && !list!.blueprints.some((b) => b.path === q.path)) list!.blueprints.push({ path: q.path, name: q.path.split(".").pop() ?? q.path, parent: q.parent ?? "Actor", pending: true } as { path: string; name: string; parent?: string });
    }
    const blueprints = await Promise.all(
      list!.blueprints.map(async (b) => ({ ...b, saved: !!(await this.readJson(join(this.projectDir(project), "graphs", fileFor(b.path)))) })),
    );
    return { blueprints: blueprints.sort((a, b) => a.name.localeCompare(b.name)), offline, project };
  }

  /**
   * One Blueprint's graphs: from the editor when connected (and saved here), else the saved copy.
   *
   * @param path - The Blueprint's object path, e.g. `/Game/BP_Door.BP_Door`.
   * @returns The graphs, and whether they came from the saved copy.
   * @throws Error when the editor is closed and the Blueprint was never read.
   */
  async graph(path: string): Promise<{ graph: BlueprintJson; offline: boolean; savedAt?: string; pending?: number; compile?: CompileRecord }> {
    const project = await this.project();
    if (!project) throw new Error(`Connect the ${this.editor} once first.`);
    const file = join(this.projectDir(project), "graphs", fileFor(path));
    const compile = await this.lastCompile(project, path);
    const extra = compile ? { compile } : {};
    if (this.connected) {
      try {
        const graph = await this.request<BlueprintJson>("graph", { path });
        const savedAt = new Date().toISOString();
        await this.writeJson(file, { graph, savedAt });
        return { graph, offline: false, savedAt, ...extra };
      } catch (err) {
        if (this.connected) throw err;
      }
    }
    // Unreal closed: the saved copy with the changes still waiting applied on top (shared/unreal-bp.ts), so an edit
    // made with Unreal closed shows at once.
    const saved = (await this.readJson<{ graph: BlueprintJson; savedAt: string }>(file)) ?? (await this.starterCopy(project, path));
    if (saved) return { ...(await this.withPending(project, path, saved.graph)), offline: true, savedAt: saved.savedAt, ...extra };
    if (this.available) {
      const graph = await this.request<BlueprintJson>("graph", { path }, 900_000);
      const savedAt = new Date().toISOString();
      await this.writeJson(file, { graph, savedAt });
      return { graph, offline: true, savedAt, ...extra };
    }
    throw new Error(`This graph was not opened while the ${this.editor} was connected, so there is no copy of it here yet.`);
  }

  /**
   * A Blueprint's saved copy only (never asks the editor, never starts one), for the inspector with Unreal closed.
   *
   * @param path - The Blueprint's object path.
   * @returns The copy and when it was saved, or undefined when there is none.
   */
  async savedGraph(path: string): Promise<{ graph: BlueprintJson; savedAt: string } | undefined> {
    const project = await this.project();
    if (!project) return undefined;
    return this.readJson<{ graph: BlueprintJson; savedAt: string }>(join(this.projectDir(project), "graphs", fileFor(path)));
  }

  /**
   * Keeps a graph read from the headless editor as the saved copy the page shows.
   *
   * @param path - The Blueprint's object path.
   * @param graph - Its graphs.
   */
  async remember(path: string, graph: BlueprintJson): Promise<void> {
    const project = await this.project();
    if (project) await this.writeJson(join(this.projectDir(project), "graphs", fileFor(path)), { graph, savedAt: new Date().toISOString() });
  }

  /**
   * The first copy of a Blueprint made in KesherAI while Unreal was closed (its "create" waits in the queue): an empty
   * event graph, so it can be edited at once.
   */
  private async starterCopy(project: string, path: string): Promise<{ graph: BlueprintJson; savedAt: string } | undefined> {
    const made = (await this.queue()).find((q) => q.kind === "create" && q.project === project && q.path === path);
    if (!made) return undefined;
    return { graph: { path, name: path.split(".").pop() ?? path, parent: made.parent ?? "Actor", variables: [], graphs: [{ name: "EventGraph", kind: "event", nodes: [] }] }, savedAt: made.at };
  }

  /** Blueprint classes' parents in the project (BP_Enemy → Character), for object pin checks with Unreal closed. */
  private async parentsOf(project: string): Promise<Record<string, string>> {
    const list = await this.readJson<{ blueprints: Array<{ name: string; parent?: string }> }>(join(this.projectDir(project), "list.json"));
    return Object.fromEntries((list?.blueprints ?? []).filter((b) => b.parent).map((b) => [b.name, b.parent!]));
  }

  /** The graph with the project's waiting graph changes for it applied on top. */
  private async withPending(project: string, path: string, graph: BlueprintJson): Promise<{ graph: BlueprintJson; pending?: number }> {
    const mine = (await this.queue()).filter((q) => !q.kind && q.project === project && q.path === path);
    if (!mine.length) return { graph };
    const parents = await this.parentsOf(project);
    let doc = graph as unknown as BpDoc;
    for (const q of mine) doc = applyBpOps(doc, q.graph, q.ops as BpOp[], { parents }).doc;
    return { graph: doc as unknown as BlueprintJson, pending: mine.length };
  }

  /**
   * Queues a change made on the Blueprint page with Unreal closed. It is first applied to the copy shown (with what
   * already waits), so the page gets real answers: operations Unreal would refuse (pins that do not fit, a missing
   * variable or pin) answer with the error and are not queued. Added nodes get an id here ("new-…") that later changes
   * can use; it is also their `ref`, and a graph's waiting changes sync in one apply, so Unreal knows it. A call whose
   * pins the plugin listed (kept palette) gets them, so the node shows its real pins before the sync.
   *
   * @param path - The Blueprint's object path.
   * @param graph - The graph in it.
   * @param ops - The operations.
   * @returns One result per operation, and whether any was queued.
   */
  async enqueueEdit(path: string, graph: string, ops: BpOp[]): Promise<{ queued: boolean; results: BpResult[]; failed: number }> {
    const project = await this.project();
    if (!project) throw new Error("Open the project in Unreal once (with the KesherAI Bridge plugin) so KesherAI knows it; after that it works with Unreal closed.");
    const saved = (await this.readJson<{ graph: BlueprintJson; savedAt: string }>(join(this.projectDir(project), "graphs", fileFor(path)))) ?? (await this.starterCopy(project, path));
    if (!saved) throw new Error("Open this Blueprint once with Unreal open (or press Sync now) so KesherAI has a copy to change.");
    const kept = (await this.readJson<BpAction[]>(join(this.projectDir(project), "actions.json"))) ?? [];
    const named = withTempIds(ops).map((op) => {
      if (op.op !== "add" || op.type !== "call" || Array.isArray(op.pins)) return op;
      const known = kept.find((a) => a.type === "call" && a.function === op.function && a.pins?.length);
      return known ? { ...op, pins: known.pins } : op;
    });
    const { graph: shown } = await this.withPending(project, path, saved.graph);
    const { results } = applyBpOps(shown as unknown as BpDoc, graph, named, { parents: await this.parentsOf(project) });
    const ok = named.filter((_, i) => results[i]!.ok);
    if (ok.length) {
      await this.enqueue({ project, path, graph, ops: ok, request: "Changed on the Blueprint page" });
      this.redoStack.delete(`${project}|${path}`);
    }
    return { queued: ok.length > 0, results, failed: results.filter((r) => !r.ok).length };
  }

  /** Changes taken back with Undo while Unreal was closed, per project and Blueprint (Redo puts them back). */
  private readonly redoStack = new Map<string, QueuedEdit[]>();

  /**
   * Undo / Redo with Unreal closed: takes back the Blueprint's last waiting change, or puts the last one taken back.
   *
   * @param path - The Blueprint's object path.
   * @param redo - Redo instead of undo.
   * @returns Whether there was one.
   */
  async undoQueued(path: string, redo = false): Promise<boolean> {
    const project = await this.project();
    if (!project) return false;
    const k = `${project}|${path}`;
    const stack = this.redoStack.get(k) ?? [];
    const all = await this.queue();
    if (redo) {
      const back = stack.pop();
      if (!back) return false;
      all.push(back);
    } else {
      const i = all.map((q, n) => ({ q, n })).filter(({ q }) => !q.kind && !q.clash && q.project === project && q.path === path).pop()?.n;
      if (i === undefined) return false;
      stack.push(...all.splice(i, 1));
      this.redoStack.set(k, stack.slice(-50));
    }
    await this.writeJson(join(this.dir, "queue.json"), all);
    return true;
  }

  /**
   * The node palette: Unreal's own list when the editor is connected (every answer is kept for later), else the kept
   * list with the common nodes and casts to the project's Blueprints, searched here ("Context Sensitive" from a pin).
   *
   * @param path - The Blueprint (Unreal lists the nodes for it).
   * @param query - The words typed.
   * @param from - The pin dragged from, when there is one.
   * @returns The matches, and whether they came without Unreal.
   */
  async actions(path: string, query: string, from?: { type: string; dir: "in" | "out" }): Promise<{ actions: BpAction[]; offline: boolean }> {
    const project = await this.project();
    const file = project ? join(this.projectDir(project), "actions.json") : undefined;
    const kept = (file && (await this.readJson<BpAction[]>(file))) || [];
    if (this.connected) {
      const r = await this.request<{ actions: BpAction[] }>("actions", { path, query, ...(from ? { pinType: from.type, pinDir: from.dir } : {}) }, 20_000);
      if (file && Array.isArray(r.actions)) {
        const k = (a: BpAction) => `${a.type}|${a.function ?? a.event ?? a.variable ?? ""}|${a.title}`;
        const fresh = new Map(r.actions.filter((a) => a && typeof a.title === "string").map((a) => [k(a), a]));
        // Newer answers (with pins) replace older ones; at most 5,000 kept.
        const merged = [...kept.filter((a) => !fresh.has(k(a))), ...fresh.values()].slice(-5000);
        if (fresh.size) await this.writeJson(file, merged);
      }
      return { actions: r.actions, offline: false };
    }
    const graph = project ? await this.savedGraph(path) : undefined;
    const parents = project ? await this.parentsOf(project) : {};
    // The Blueprint's own variables and functions, and casts to the project's Blueprints.
    const own: BpAction[] = [
      ...(graph?.graph.variables ?? []).flatMap((v) => [{ title: `Get ${v.name}`, category: "Variables", type: "get", variable: v.name }, { title: `Set ${v.name}`, category: "Variables", type: "set", variable: v.name }]),
      ...(graph?.graph.graphs ?? []).filter((g) => g.kind === "function").map((g) => ({ title: g.name, category: "Functions", type: "call", function: g.name })),
      ...Object.keys(parents).map((name) => ({ title: `Cast To ${name}`, category: "Utilities|Casting", type: "cast", class: name })),
    ];
    // The kept variables of this Blueprint come from the copy (another Blueprint's are not offered).
    const actions = [...own, ...kept.filter((a) => a.type !== "get" && a.type !== "set"), ...COMMON_BP_ACTIONS].map((a) => (a.type === "get" || a.type === "set") && graph ? { ...a, pins: bpNodeTemplate({ ...a }, graph.graph as unknown as BpDoc).pins } : a);
    return { actions: searchBpActions(actions, query, from, parents), offline: true };
  }

  /**
   * "Sync on open": compares the saved copy of a Blueprint with Unreal's now. With Unreal open it is asked (the copy is
   * not replaced; the page offers Refresh); with it closed, only whether the .uasset was saved after the copy was read.
   *
   * @param path - The Blueprint's object path.
   * @returns Whether they are the same, what differs, and whether Unreal was asked.
   */
  async checkSaved(path: string): Promise<{ editor: boolean; same: boolean; stale?: boolean; diff?: BpDiff; savedAt?: string; pending: number }> {
    const project = await this.project();
    const saved = project ? await this.savedGraph(path) : undefined;
    const pending = project ? (await this.queue()).filter((q) => !q.kind && q.project === project && q.path === path).length : 0;
    if (!project || !saved) return { editor: false, same: true, pending };
    if (!this.connected) {
      const file = this.lastProjectFile ?? this.info?.projectFile;
      const changed = file ? await engineChangedAt({ baseAt: saved.savedAt } as QueuedEdit, unrealAssetFile(dirname(file), path)) : undefined;
      return { editor: false, same: !changed, ...(changed ? { stale: true } : {}), savedAt: saved.savedAt, pending };
    }
    const now = await this.request<BlueprintJson>("graph", { path });
    const diff = diffBpGraphs(saved.graph as unknown as BpDoc, now as unknown as BpDoc);
    return { editor: true, same: diff.same, diff, savedAt: saved.savedAt, pending };
  }

  /**
   * Keeps a compile's result, its messages tied to nodes (the page marks them), for when the graph is read again.
   *
   * @param path - The Blueprint's object path.
   * @param answer - The plugin's compile answer.
   * @param graph - The Blueprint as read after the compile (to tie messages to nodes by title for an older plugin).
   * @returns The kept record.
   */
  async recordCompile(path: string, answer: unknown, graph?: BlueprintJson): Promise<CompileRecord | undefined> {
    const project = await this.project();
    if (!project || !answer || typeof answer !== "object") return undefined;
    const a = answer as { ok?: boolean; messages?: Array<{ severity?: string; text?: string }>; nodes?: Array<{ node?: string; graph?: string; severity?: string; text?: string }> };
    const doc = graph ?? (await this.savedGraph(path))?.graph;
    const messages = mapCompileMessages(a, doc as unknown as BpDoc | undefined).slice(0, 200);
    const rec: CompileRecord = { ok: a.ok !== false && !messages.some((m) => m.severity === "error"), at: new Date().toISOString(), messages };
    await this.writeJson(join(this.projectDir(project), "compile", fileFor(path)), rec);
    return rec;
  }

  /** The last compile's result for a Blueprint (none when it never compiled through KesherAI). */
  private async lastCompile(project: string, path: string): Promise<CompileRecord | undefined> {
    return this.readJson<CompileRecord>(join(this.projectDir(project), "compile", fileFor(path)));
  }

  /** @returns Changes waiting for the editor. */
  async queue(): Promise<QueuedEdit[]> {
    return (await this.readJson<QueuedEdit[]>(join(this.dir, "queue.json"))) ?? [];
  }

  private syncTimer?: NodeJS.Timeout;
  private syncing?: Promise<{ applied: number; failed: number }>;
  /** Where the background sync stands (the page shows it). */
  syncState: { running: boolean; lastAt?: string; lastError?: string } = { running: false };

  /**
   * Work without the editor open (Roee, 2026-11-17: "work and sync, no constant connection"): a change made while the
   * editor is closed is queued, and a few seconds after the last one the queue is applied in one headless editor start
   * (compiled and saved there); the graphs are read again. Opening the editor first also applies it (afterConnect).
   *
   * @param delayMs - Quiet time after the last change before syncing.
   */
  scheduleSync(delayMs = 8000): void {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.syncNow().catch(() => undefined), delayMs);
    this.syncTimer.unref?.();
  }

  /** Applies the queued changes now, in one headless editor start (the editor being closed). */
  async syncNow(): Promise<{ applied: number; failed: number }> {
    if (this.connected) {
      await this.afterConnect();
      return { applied: 0, failed: 0 };
    }
    let clashes = 0;
    let project: string | undefined;
    this.syncing ??= (async () => {
      this.syncState = { running: true };
      project = await this.project();
      if (!project) return { applied: 0, failed: 0 };
      // Changes that clash with an edit saved in Unreal wait for Roee's choice (the Sync and conflicts sheet).
      const { apply: sorted, newClashes } = await this.sortMine(project);
      clashes = newClashes.length;
      // Collapse to Function needs the open editor (the plugin says so): a graph's changes with one wait for it.
      const held = new Set(sorted.filter(needsEditor).map((q) => q.path));
      const mine = sorted.filter((q) => q.kind || !held.has(q.path));
      if (!mine.length) return { applied: 0, failed: 0 };
      await this.checkpoint(project, mine);
      const commands: Array<Record<string, unknown>> = [];
      const groups = mergeEdits(mine);
      for (const g of groups) {
        const q = g.edits[0]!;
        if (q.kind === "create") commands.push({ cmd: "create", path: q.path, parent: q.parent ?? "Actor" });
        else if (ownCommand(q)) commands.push(queuedCommand(q));
        else commands.push({ cmd: "apply", path: g.path, graph: g.graph, ops: g.ops });
      }
      // Blueprints are compiled, saved and read again; a level is saved by its own command.
      const paths = [...new Set(mine.filter((q) => !ownCommand(q)).map((q) => q.path))];
      const compileAt = commands.length;
      for (const path of paths) commands.push({ cmd: "compile", path }, { cmd: "save", path });
      for (const path of paths) commands.push({ cmd: "graph", path });
      const answers = await this.offline(commands);
      let applied = 0;
      let failed = 0;
      for (let i = 0; i < groups.length; i++) {
        const a = answers[i] as { ok?: boolean } | undefined;
        const g = groups[i]!;
        if (a && a.ok !== false) {
          applied += g.edits.length;
          for (const e of g.edits) {
            await this.unqueue(e.id);
            // A level changed: its kept copy is old now (the next read takes it again).
            if (e.kind === "material" || e.kind === "spawn") await rm(join(this.projectDir(project), "standin", `level-${fileFor(e.path)}`), { force: true }).catch(() => undefined);
          }
        } else failed += g.edits.length;
      }
      // The graphs read at the end become the saved copies the page shows; the compile's messages are tied to them.
      for (let i = 0; i < paths.length; i++) {
        const a = answers[commands.length - paths.length + i] as { ok?: boolean; result?: unknown } | undefined;
        const read = a?.ok !== false && a?.result ? (a.result as BlueprintJson) : undefined;
        if (read) await this.remember(paths[i]!, read).catch(() => undefined);
        const c = answers[compileAt + i * 2] as { ok?: boolean; result?: unknown } | undefined;
        if (c?.result) await this.recordCompile(paths[i]!, c.result, read).catch(() => undefined);
      }
      return { applied, failed };
    })()
      .then((r) => {
        const lastError = r.failed ? `${r.failed} change(s) could not be applied; they stay waiting.` : undefined;
        this.syncState = { running: false, lastAt: new Date().toISOString(), ...(lastError ? { lastError } : {}) };
        if (project && (r.applied || r.failed || clashes)) this.onSync?.({ engine: "unreal", project, ...r, clashes, ...(lastError ? { error: lastError } : {}) });
        return r;
      }, (e: Error) => {
        this.syncState = { running: false, lastAt: new Date().toISOString(), lastError: e.message };
        if (project) this.onSync?.({ engine: "unreal", project, applied: 0, failed: 0, clashes, error: e.message });
        throw e;
      })
      .finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  /**
   * Keeps a change for when the editor connects.
   *
   * @param edit - The change.
   * @returns It, with its id.
   */
  async enqueue(edit: Omit<QueuedEdit, "id" | "at">): Promise<QueuedEdit> {
    // The saved copy the change was made on: for the clash check when it syncs (game-sync.ts).
    const saved = edit.kind === "create" || edit.baseAt ? undefined : await this.readJson<{ graph: BlueprintJson; savedAt: string }>(join(this.projectDir(edit.project), "graphs", fileFor(edit.path)));
    const base = saved ? { baseAt: saved.savedAt, baseSig: nodeSig(saved.graph) } : {};
    const q = await this.queue();
    const item = { ...base, ...edit, id: randomUUID(), at: new Date().toISOString() };
    q.push(item);
    await this.writeJson(join(this.dir, "queue.json"), q);
    return item;
  }

  /**
   * Removes a waiting change.
   *
   * @param id - Its id.
   * @returns Whether it was there.
   */
  async unqueue(id: string): Promise<boolean> {
    const q = await this.queue();
    const left = q.filter((x) => x.id !== id);
    await this.writeJson(join(this.dir, "queue.json"), left);
    return left.length !== q.length;
  }

  /**
   * A new Blueprint: made in the editor now when it is connected; otherwise
   * kept (with an empty graph you can already change, in words or by hand)
   * and made when the editor opens, before the changes made to it meanwhile.
   *
   * @param name - Its name, e.g. BP_Door.
   * @param folder - Where under /Game, e.g. /Game/Blueprints.
   * @param parent - The parent class (UserWidget makes a Widget Blueprint).
   * @returns Its object path, and whether it waits for the editor.
   */
  async createBlueprint(name: string, folder: string, parent: string): Promise<{ path: string; queued: boolean }> {
    if (!/^[A-Za-z_][A-Za-z0-9_]{1,63}$/.test(name)) throw new Error("A name of letters, digits and _ (e.g. BP_Door).");
    const dir = `/${folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}`;
    if (!/^\/Game(\/[A-Za-z0-9_]+)*$/.test(dir)) throw new Error("The folder must be under /Game (e.g. /Game/Blueprints).");
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(parent)) throw new Error("Choose a parent class.");
    const path = `${dir}/${name}.${name}`;
    if (this.connected) {
      await this.request("create", { path, parent }, 60_000);
      await this.list().catch(() => undefined);
      return { path, queued: false };
    }
    const project = await this.project();
    if (!project) throw new Error(`Connect the ${this.editor} once first, so KesherAI knows the project.`);
    if (this.available) {
      // A headless editor makes it now; when that cannot start (no engine here, an older plugin) it waits as before.
      const answers = await this.offline([{ cmd: "create", path, parent }, { cmd: "list" }]).catch(() => undefined);
      if (answers) {
        const [made, listed] = answers;
        if (!made?.ok) throw new Error(made?.error ?? "Unreal could not make it.");
        if (listed?.ok) await this.writeJson(join(this.projectDir(project), "list.json"), listed.result);
        return { path, queued: false };
      }
    }
    if ((await this.queue()).some((q) => q.kind === "create" && q.path === path)) throw new Error("That Blueprint is already waiting to be made.");
    await this.enqueue({ project, path, graph: "EventGraph", ops: [], kind: "create", parent, request: `New ${parent === "UserWidget" ? "Widget Blueprint" : `Blueprint (${parent})`}` });
    // An empty graph to work on until Unreal opens.
    const graph: BlueprintJson = { path, name, parent, variables: [], graphs: [{ name: "EventGraph", kind: "event", nodes: [] }] };
    await this.writeJson(join(this.projectDir(project), "graphs", fileFor(path)), { graph, savedAt: new Date().toISOString() });
    return { path, queued: true };
  }

  /** When a Blueprint last compiled in the editor (ms), for the page to read the graph again. */
  private changedAt = 0;

  /** @returns What the page shows. */
  async status(): Promise<BridgeStatus> {
    const { readdir } = await import("node:fs/promises");
    const projects = (await readdir(this.dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && !e.name.startsWith("_")).map((e) => e.name);
    await this.project();
    return { connected: this.connected, ...(this.info ? { editor: this.info } : {}), projects, queued: (await this.queue()).length, ...(this.changedAt ? { changedAt: this.changedAt } : {}), ...(!this.connected && this.available ? { offline: true } : {}) };
  }
}

/** A Blueprint as the plugin describes it. */
export interface BlueprintJson {
  path: string;
  name: string;
  parent?: string;
  /** ptype…category: plugin 0.1.9+ / Unity package 0.2.2+ (the variables panel). */
  variables: Array<{ name: string; type: string; ptype?: string; default?: string; editable?: boolean; tooltip?: string; category?: string; private?: boolean }>;
  graphs: Array<{
    name: string;
    kind: "event" | "function" | "macro";
    nodes: Array<{
      id: string;
      title: string;
      class: string;
      x: number;
      y: number;
      comment?: string;
      function?: string;
      variable?: string;
      pins: Array<{ name: string; label?: string; dir: "in" | "out"; type: string; default?: string; links?: string[] }>;
    }>;
  }>;
}

/**
 * The instructions for turning words into graph operations.
 *
 * @param bp - The Blueprint.
 * @param graphName - The graph to change.
 * @param request - What the user wants.
 * @returns Messages for the chat model.
 */
export function blueprintPrompt(bp: BlueprintJson, graphName: string, request: string): Array<{ role: "system" | "user"; content: string }> {
  const graph = bp.graphs.find((g) => g.name === graphName) ?? bp.graphs[0];
  const compact = (graph?.nodes ?? []).map((n) => ({
    id: n.id,
    title: n.title,
    ...(n.function ? { function: n.function } : {}),
    ...(n.variable ? { variable: n.variable } : {}),
    x: n.x,
    y: n.y,
    pins: n.pins.map((p) => `${p.dir} ${p.name}${p.label ? ` "${p.label}"` : ""} (${p.type})${p.default !== undefined ? ` = ${p.default}` : ""}${p.links?.length ? ` -> ${p.links.join(", ")}` : ""}`),
  }));
  const system = [
    "You edit Unreal Engine Blueprint graphs. Answer with ONE JSON object and nothing else:",
    '{"ops": [...], "note": "one short sentence for the user, in the language of the request"}',
    "Operations (applied in order, as one undo step):",
    '- {"op":"add","ref":"$name","type":"call","function":"KismetSystemLibrary:PrintString","x":0,"y":0}  (any UFUNCTION: "Class:Function"; a function of this Blueprint: just "Function")',
    '- {"op":"add","ref":"$e","type":"event","event":"ReceiveBeginPlay"}  (events of the parent class: ReceiveBeginPlay, ReceiveTick, ReceiveActorBeginOverlap…)',
    '- {"op":"add","ref":"$c","type":"custom_event","name":"OnOpened"}',
    '- {"op":"add","ref":"$b","type":"branch"}   {"op":"add","ref":"$s","type":"sequence"}',
    '- {"op":"add","ref":"$g","type":"get","variable":"Health"}   {"op":"add","ref":"$v","type":"set","variable":"Health"}  (only variables listed below)',
    '- {"op":"connect","from":{"node":"<id or $ref>","pin":"<output pin>"},"to":{"node":"<id or $ref>","pin":"<input pin>"}}  (execution pins: "then" out, "execute" in; Branch outputs "then"/"else", input "Condition"; PrintString input "InString")',
    '- {"op":"set","node":"<id or $ref>","pin":"<input pin>","value":"<text>"}',
    '- {"op":"move","node":"…","x":0,"y":0}   {"op":"delete","node":"…"}   {"op":"comment","node":"…","text":"…"}',
    "Use pin names exactly as listed. Place new nodes to the right of what they follow (x + 300) so nothing overlaps. Keep what the user did not ask to change.",
  ].join("\n");
  const user = [
    `Blueprint ${bp.name}${bp.parent ? ` (parent ${bp.parent})` : ""}. Graph "${graph?.name ?? graphName}".`,
    `Variables: ${bp.variables.map((v) => `${v.name} (${v.type})`).join(", ") || "none"}.`,
    `Other graphs: ${bp.graphs.filter((g) => g !== graph).map((g) => `${g.name} (${g.kind})`).join(", ") || "none"}.`,
    `Nodes:\n${JSON.stringify(compact)}`,
    `Change: ${request}`,
  ].join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * A pin's name as the model may have copied it from the prompt's pin line
 * (`out then (exec)`, `in InString "In String" (string) = Hi`): just the name.
 * Found testing on the real editor: a small model wrote "out then (exec)" and
 * the connection failed with "Pin not found".
 *
 * @param s - What the model wrote.
 * @returns The pin name.
 */
export function pinName(s: string): string {
  return s
    .trim()
    .replace(/^(in|out)\s+/i, "")
    .replace(/\s*->.*$/, "")
    .replace(/\s*=.*$/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+"[^"]*"\s*$/, "")
    .trim();
}

/** The pins of one operation, cleaned with {@link pinName}. */
function cleanPins(op: Record<string, unknown>): Record<string, unknown> {
  const out = { ...op };
  for (const k of ["from", "to"] as const) {
    const end = out[k] as { pin?: unknown } | undefined;
    if (end && typeof end === "object" && typeof end.pin === "string") out[k] = { ...end, pin: pinName(end.pin) };
  }
  if (typeof out.pin === "string") out.pin = pinName(out.pin);
  return out;
}

/**
 * Reads the model's answer.
 *
 * @param text - What the model wrote.
 * @returns The operations and its note.
 * @throws Error when there is no JSON object with an `ops` list.
 */
export function parseOps(text: string): { ops: Array<Record<string, unknown>>; note: string } {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  for (let end = cleaned.lastIndexOf("}"); start >= 0 && end > start; end = cleaned.lastIndexOf("}", end - 1)) {
    try {
      const j = JSON.parse(cleaned.slice(start, end + 1)) as { ops?: unknown; note?: unknown };
      if (Array.isArray(j.ops)) return { ops: j.ops.filter((o): o is Record<string, unknown> => !!o && typeof o === "object" && typeof (o as { op?: unknown }).op === "string").map(cleanPins), note: typeof j.note === "string" ? j.note : "" };
    } catch {
      // try a shorter slice
    }
  }
  throw new Error("The model did not answer with changes. Try again, or with a larger model.");
}

/**
 * The instructions for turning words into Unity Visual Scripting operations.
 *
 * @param g - The Script Graph (same shape as a Blueprint).
 * @param request - What the user wants.
 * @returns Messages for the chat model.
 */
export function unityPrompt(g: BlueprintJson, request: string): Array<{ role: "system" | "user"; content: string }> {
  const graph = g.graphs[0];
  const compact = (graph?.nodes ?? []).map((n) => ({
    id: n.id,
    title: n.title,
    x: n.x,
    y: n.y,
    ports: n.pins.map((p) => `${p.dir} ${p.name} (${p.type})${p.default !== undefined ? ` = ${p.default}` : ""}${p.links?.length ? ` -> ${p.links.join(", ")}` : ""}`),
  }));
  const system = [
    "You edit Unity Visual Scripting script graphs. Answer with ONE JSON object and nothing else:",
    '{"ops": [...], "note": "one short sentence for the user, in the language of the request"}',
    "Operations (applied in order, as one undo step):",
    '- {"op":"add","ref":"$s","type":"event","event":"Start"}  (Unity events: Start, Update, FixedUpdate, OnEnable, OnTriggerEnter, OnCollisionEnter, OnMouseDown…)',
    '- {"op":"add","ref":"$l","type":"call","function":"UnityEngine.Debug:Log","args":1}  (any public method: "Namespace.Type:Method"; args = how many parameters, to pick the overload)',
    '- {"op":"add","ref":"$i","type":"unit","unit":"If"}  (any unit by its class name: If, Sequence, SwitchOnString, ForLoop, Wait…)',
    '- {"op":"add","ref":"$g","type":"get","variable":"health","kind":"Graph"}   {"op":"add","ref":"$v","type":"set","variable":"health","kind":"Object"}  (kind: Flow, Graph, Object, Scene, Application, Saved)',
    '- {"op":"add","ref":"$t","type":"literal","valueType":"string","value":"Hello"}  (string, int, float, bool)',
    '- {"op":"add","ref":"$c","type":"custom_event","name":"Opened"}',
    '- {"op":"connect","from":{"node":"<id or $ref>","pin":"<output port>"},"to":{"node":"<id or $ref>","pin":"<input port>"}}  (control ports: event "trigger" → "enter"; a node\'s "exit" → next "enter"; If outputs "ifTrue"/"ifFalse", input "condition"; Debug.Log input "message"; a variable or literal output "value"; Set Variable input "input", output "output")',
    '- {"op":"set","node":"<id or $ref>","pin":"<input port>","value":"<text>"}',
    '- {"op":"move","node":"…","x":0,"y":0}   {"op":"delete","node":"…"}',
    "Use port names exactly as listed. Place new nodes to the right of what they follow (x + 250) so nothing overlaps. Keep what the user did not ask to change.",
  ].join("\n");
  const user = [
    `Script Graph ${g.name}.`,
    `Graph variables: ${g.variables.map((v) => `${v.name} (${v.type})`).join(", ") || "none"}.`,
    `Nodes:\n${JSON.stringify(compact)}`,
    `Change: ${request}`,
  ].join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** The .uproject file in a project folder. */
async function uprojectIn(dir: string): Promise<string | undefined> {
  const { readdir } = await import("node:fs/promises");
  const f = (await readdir(dir).catch(() => [] as string[])).find((n) => /\.uproject$/i.test(n));
  return f ? join(dir, f) : undefined;
}
