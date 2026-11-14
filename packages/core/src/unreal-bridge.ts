import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type WebSocket from "ws";

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
export const BRIDGE_VERSION = "0.1.16";

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
  /** "create": make this Blueprint first (it was made in KesherAI with Unreal closed). */
  kind?: "create";
  /** For "create": the parent class (Actor, Pawn, Character, GameModeBase, PlayerController, ActorComponent, UserWidget…). */
  parent?: string;
  at: string;
}

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
const OFFLINE_COMMANDS = new Set(["list", "graph", "apply", "vars", "compile", "save", "actions", "widget", "create", "import_texture", "widget_apply"]);

const slug = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 80) || "project";
const fileFor = (path: string) => `${createHash("sha256").update(path).digest("hex").slice(0, 24)}.json`;

/** The bridge. One per server. */
export class UnrealBridge {
  private socket?: WebSocket;
  private info?: EditorInfo;
  private readonly waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(event: string) => void>();
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
  async offline(commands: Array<Record<string, unknown>>): Promise<HeadlessAnswer[]> {
    await this.project();
    const file = this.lastProjectFile;
    if (!this.headless || !file || !existsSync(file)) throw new Error(`The ${this.editor} is closed and KesherAI does not know the project yet: open it once with the KesherAI Bridge plugin.`);
    const run = this.headlessChain.then(() => this.headless!(file, commands));
    this.headlessChain = run.catch(() => undefined);
    const answers = await run;
    if (commands.some((c) => c.cmd !== "list" && c.cmd !== "graph" && c.cmd !== "actions" && c.cmd !== "widget")) {
      this.changedAt = Date.now();
      this.emit("changed");
    }
    return answers;
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
      for (const [id, w] of this.waiting) {
        clearTimeout(w.timer);
        w.reject(new Error(`The ${this.editor} disconnected.`));
        this.waiting.delete(id);
      }
      this.emit("disconnected");
    });
  }

  private async onMessage(socket: WebSocket, text: string): Promise<void> {
    let msg: { id?: string; ok?: boolean; result?: unknown; error?: string; event?: string; project?: string; engine?: string; bridge?: string; projectFile?: string; pid?: number };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (msg.event === "hello" && socket === this.socket) {
      // Only a real .uproject on this computer is kept (the chat's Unreal tools then work on that project).
      const pf = typeof msg.projectFile === "string" && /\.uproject$/i.test(msg.projectFile) && existsSync(msg.projectFile) ? msg.projectFile : undefined;
      const pid = typeof msg.pid === "number" && Number.isInteger(msg.pid) && msg.pid > 0 ? msg.pid : undefined;
      this.info = { project: String(msg.project ?? "Project"), engine: String(msg.engine ?? ""), bridge: String(msg.bridge ?? ""), ...(pf ? { projectFile: pf } : {}), ...(pid ? { pid } : {}), connectedAt: new Date().toISOString() };
      this.lastProject = this.info.project;
      if (pf) this.lastProjectFile = pf;
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, "last.json"), JSON.stringify({ last: this.info.project, ...(this.lastProjectFile ? { projectFile: this.lastProjectFile } : {}) }));
      this.emit("connected");
      void this.afterConnect().catch(() => undefined);
      return;
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
    for (const q of await this.queue()) {
      if (q.project !== this.info?.project) continue;
      try {
        // A Blueprint made in KesherAI while Unreal was closed: made now, before the changes that follow it in the queue.
        if (q.kind === "create") {
          await this.request("create", { path: q.path, parent: q.parent ?? "Actor" }, 60_000);
          await this.unqueue(q.id);
          await this.list().catch(() => undefined);
          continue;
        }
        await this.request("apply", { path: q.path, graph: q.graph, ops: q.ops });
        await this.request("compile", { path: q.path }).catch(() => undefined);
        await this.unqueue(q.id);
        await this.graph(q.path).catch(() => undefined);
      } catch {
        // stays queued; the page shows it
      }
    }
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
  async graph(path: string): Promise<{ graph: BlueprintJson; offline: boolean; savedAt?: string }> {
    const project = await this.project();
    if (!project) throw new Error(`Connect the ${this.editor} once first.`);
    const file = join(this.projectDir(project), "graphs", fileFor(path));
    if (this.connected) {
      try {
        const graph = await this.request<BlueprintJson>("graph", { path });
        const savedAt = new Date().toISOString();
        await this.writeJson(file, { graph, savedAt });
        return { graph, offline: false, savedAt };
      } catch (err) {
        if (this.connected) throw err;
      }
    }
    const saved = await this.readJson<{ graph: BlueprintJson; savedAt: string }>(file);
    if (saved) return { ...saved, offline: true };
    if (this.available) {
      const graph = await this.request<BlueprintJson>("graph", { path }, 900_000);
      const savedAt = new Date().toISOString();
      await this.writeJson(file, { graph, savedAt });
      return { graph, offline: true, savedAt };
    }
    throw new Error(`This graph was not opened while the ${this.editor} was connected, so there is no copy of it here yet.`);
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

  /** @returns Changes waiting for the editor. */
  async queue(): Promise<QueuedEdit[]> {
    return (await this.readJson<QueuedEdit[]>(join(this.dir, "queue.json"))) ?? [];
  }

  /**
   * Keeps a change for when the editor connects.
   *
   * @param edit - The change.
   * @returns It, with its id.
   */
  async enqueue(edit: Omit<QueuedEdit, "id" | "at">): Promise<QueuedEdit> {
    const q = await this.queue();
    const item = { ...edit, id: randomUUID(), at: new Date().toISOString() };
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
