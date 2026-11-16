import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { GODOT_ADDON } from "./godot-addon.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";

/**
 * The link to the Godot editor (the KesherAI Bridge addon, integrations/godot/addons/kesher_bridge).
 *
 * Like the Unreal bridge: the editor connects to KesherAI (never the other way round), from this computer only, and
 * answers commands (tree, get, add, set, remove, attach_script, open, new_scene, save, read, write, files, run, stop,
 * playing, log, screenshot). Every change in the editor is one undo step there.
 */

/** The addon version this KesherAI ships. */
export const GODOT_BRIDGE_VERSION = "0.1.0";

/** What the editor said when it connected. */
export interface GodotEditor {
  project: string;
  engine: string;
  bridge: string;
  /** The project's project.godot on this computer. */
  projectFile?: string;
  pid?: number;
  /** The project has a .csproj (C#). */
  csharp?: boolean;
  connectedAt: string;
}

/** The Godot editor link: its state, its commands, and adding the addon to a project. */
export class GodotBridge {
  /** A Godot editor was found on this computer (the chat then offers godot_status and godot_connect). */
  installed = false;
  private socket?: WebSocket;
  private editor?: GodotEditor;
  private readonly waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  /**
   * @param enginesDir - Where KesherAI keeps engines (Godot is looked for in its `godot` folder).
   */
  constructor(private readonly enginesDir: string) {}

  /** @returns Whether an editor is connected, and which. */
  status(): { connected: boolean; editor?: GodotEditor; latest: string } {
    return { connected: !!this.socket && !!this.editor, ...(this.editor ? { editor: this.editor } : {}), latest: GODOT_BRIDGE_VERSION };
  }

  /** Takes a new connection from the editor (a newer one replaces an older one). */
  attach(socket: WebSocket): void {
    this.socket?.close();
    this.socket = socket;
    this.editor = undefined;
    socket.on("message", (data) => this.onMessage(socket, String(data)));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.editor = undefined;
      for (const [id, w] of this.waiting) {
        clearTimeout(w.timer);
        w.reject(new Error("The Godot editor disconnected."));
        this.waiting.delete(id);
      }
    });
  }

  private onMessage(socket: WebSocket, text: string): void {
    let msg: { id?: string; ok?: boolean; result?: unknown; error?: string; event?: string; project?: unknown; engine?: unknown; bridge?: unknown; projectFile?: unknown; pid?: unknown; csharp?: unknown };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (msg.event === "hello" && socket === this.socket) {
      const pf = typeof msg.projectFile === "string" && /project\.godot$/i.test(msg.projectFile) && existsSync(msg.projectFile) ? msg.projectFile : undefined;
      this.editor = {
        project: String(msg.project ?? "Project").slice(0, 120),
        engine: String(msg.engine ?? "").slice(0, 60),
        bridge: String(msg.bridge ?? "").slice(0, 20),
        ...(pf ? { projectFile: pf } : {}),
        ...(typeof msg.pid === "number" && Number.isInteger(msg.pid) && msg.pid > 0 ? { pid: msg.pid } : {}),
        ...(msg.csharp === true ? { csharp: true } : {}),
        connectedAt: new Date().toISOString(),
      };
      return;
    }
    const w = msg.id ? this.waiting.get(msg.id) : undefined;
    if (!w || !msg.id) return;
    this.waiting.delete(msg.id);
    clearTimeout(w.timer);
    if (msg.ok) w.resolve(msg.result);
    else w.reject(new Error(msg.error ?? "The Godot editor could not do that."));
  }

  /**
   * Sends a command to the editor.
   *
   * @throws Error when no editor is connected, it fails, or it does not answer in time.
   */
  request<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const socket = this.socket;
    if (!socket || !this.editor) return Promise.reject(new Error("The Godot editor is not connected. Open the project in Godot with the KesherAI Bridge addon (godot_connect adds it)."));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("The Godot editor did not answer in time."));
      }, timeoutMs);
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ id, cmd, ...args }));
    });
  }

  /**
   * Adds the addon to a project and turns it on in project.godot (the project works the same without it; removing the
   * folder and the line takes it out).
   *
   * @param projectDir - The folder with project.godot.
   */
  async connectProject(projectDir: string): Promise<{ added: boolean; enabled: boolean }> {
    const file = join(projectDir, "project.godot");
    if (!existsSync(file)) throw Object.assign(new Error("That folder has no project.godot."), { statusCode: 400 });
    const dir = join(projectDir, "addons", "kesher_bridge");
    await mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(GODOT_ADDON)) await writeFile(join(dir, name), text);
    const text = await readFile(file, "utf8");
    const entry = '"res://addons/kesher_bridge/plugin.cfg"';
    if (text.includes(entry)) return { added: true, enabled: true };
    await writeFile(file, enablePlugin(text, entry));
    return { added: true, enabled: true };
  }

  /** @returns Godot editors on this computer: KesherAI's own (engines/godot) first, then common install places. */
  async findGodot(): Promise<Array<{ path: string; csharp: boolean; version: string }>> {
    const roots = [join(this.enginesDir, "godot"), join(homedir(), "AppData", "Local", "Programs"), join(homedir(), "Downloads"), "C:\\Program Files\\Godot", "/usr/local/bin", "/Applications"];
    const out: Array<{ path: string; csharp: boolean; version: string }> = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 3 || out.length > 20) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory() && /godot|mono|standard/i.test(e.name)) await walk(p, depth + 1);
        else if (e.isFile() && /^Godot_v[\d.]+-[a-z]+(_mono)?_(win64|linux\.x86_64)(\.exe)?$/i.test(e.name)) out.push({ path: p, csharp: /_mono_/i.test(e.name), version: /v([\d.]+)/.exec(e.name)?.[1] ?? "" });
      }
    };
    for (const r of roots) await walk(r, 0);
    return out.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  }
}

/**
 * Adds a plugin to project.godot's [editor_plugins] enabled list (made when missing).
 *
 * @param text - project.godot.
 * @param entry - The quoted plugin.cfg path.
 */
export function enablePlugin(text: string, entry: string): string {
  const line = /^enabled=PackedStringArray\((.*)\)[ \t]*$/m;
  if (/^\[editor_plugins\]\s*$/m.test(text) && line.test(text)) {
    return text.replace(line, (_m, inner: string) => `enabled=PackedStringArray(${inner.trim() ? `${inner.trim()}, ` : ""}${entry})`);
  }
  if (/^\[editor_plugins\]\s*$/m.test(text)) return text.replace(/^\[editor_plugins\]\s*$/m, `[editor_plugins]\n\nenabled=PackedStringArray(${entry})`);
  return `${text.trimEnd()}\n\n[editor_plugins]\n\nenabled=PackedStringArray(${entry})\n`;
}
