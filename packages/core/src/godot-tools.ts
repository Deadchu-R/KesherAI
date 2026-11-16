import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool } from "@kesher/agent";
import type { GodotBridge } from "./godot-bridge.js";

/** One short line while no Godot editor is connected (few tokens). */
export const GODOT_IDLE_NOTE = "Godot: godot_status says whether the editor is connected; godot_connect adds KesherAI's addon to a Godot project and opens it.";

/** The guide while the editor is connected. */
export const GODOT_NOTE =
  "Godot (connected, KesherAI Bridge): work in the open editor. godot_tree shows the scene; godot_get reads a node's properties; godot_edit adds, sets, removes nodes and attaches scripts (each change is one Ctrl+Z in Godot; values in Godot's own form, e.g. \"Vector2(10, 20)\", \"Color(1, 0, 0, 1)\", \"res://icon.svg\"); godot_scene makes, opens or saves a scene; godot_file reads and writes project files (GDScript .gd or C# .cs, shaders, only under res://). After changes: godot_run, then godot_log for errors, godot_stop; godot_screenshot to see the editor view. Never say something was made or works unless a tool result here shows it. C# projects: write .cs files, then the user builds with Godot's Build button (or run, which builds first).";

const MAX = 9000;
const cut = (s: string) => (s.length > MAX ? `${s.slice(0, MAX)}\n…(${s.length - MAX} more characters)` : s);

/**
 * The Godot tools for a chat.
 *
 * @param bridge - The editor link.
 * @param saveImage - Keeps a screenshot as an asset (shown in the chat).
 */
export function godotTools(bridge: GodotBridge, saveImage: (png: Buffer) => Promise<string>): AgentTool[] {
  const req = <T>(cmd: string, args: Record<string, unknown> = {}, ms?: number) => bridge.request<T>(cmd, args, ms);
  return [
    {
      risk: "read",
      spec: { name: "godot_status", description: "Whether a Godot editor is connected to KesherAI (project, Godot version, C# or not), and the Godot editors installed here.", inputSchema: { type: "object", properties: {} } },
      run: async () => {
        const st = bridge.status();
        const found = await bridge.findGodot();
        return {
          output: `${st.connected && st.editor ? `Connected: ${st.editor.project} · Godot ${st.editor.engine}${st.editor.csharp ? " · C#" : ""}${st.editor.projectFile ? ` · ${st.editor.projectFile}` : ""}` : "No Godot editor is connected."}\nGodot editors here: ${found.length ? found.map((g) => `${g.path}${g.csharp ? " (C#/.NET)" : ""}`).join("; ") : "none found"}`,
        };
      },
    },
    {
      risk: "write",
      spec: {
        name: "godot_connect",
        description: "Connect a Godot project: add KesherAI's addon (addons/kesher_bridge, turned on in project.godot; the project works the same without it) and open the project in the Godot editor. Use a folder with project.godot; with csharp true, the .NET editor is used.",
        inputSchema: { type: "object", properties: { project: { type: "string", description: "The project folder (with project.godot)." }, csharp: { type: "boolean" } }, required: ["project"] },
      },
      preview: async (input) => `Add the KesherAI Bridge addon to ${String(input.project)} and open it in Godot.`,
      run: async (input) => {
        const dir = String(input.project ?? "").replace(/[\\/]project\.godot$/i, "");
        await bridge.connectProject(dir);
        const editors = await bridge.findGodot();
        const ed = editors.find((g) => g.csharp === (input.csharp === true)) ?? editors[0];
        if (!ed) return { output: "The addon is in the project. No Godot editor was found here: tell the user to open the project in Godot (Godot 4.2 or newer)." };
        if (!existsSync(ed.path)) return { output: "The addon is in the project; the Godot editor file is missing." };
        const child = spawn(ed.path, ["--editor", "--path", dir], { cwd: dirname(ed.path), detached: true, stdio: "ignore", windowsHide: false });
        child.unref();
        return { output: `The addon is in the project and Godot ${ed.version}${ed.csharp ? " (.NET)" : ""} is opening it. Wait a few seconds, then godot_status.` };
      },
    },
    {
      risk: "read",
      spec: { name: "godot_tree", description: "The open scene's node tree (names, types, attached scripts).", inputSchema: { type: "object", properties: { depth: { type: "number", description: "Default 6." } } } },
      run: async (input) => ({ output: cut(JSON.stringify(await req("tree", { depth: Number(input.depth ?? 6) || 6 }))) }),
    },
    {
      risk: "read",
      spec: { name: "godot_get", description: "A node's editable properties and their values (path relative to the scene root; empty for the root).", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
      run: async (input) => ({ output: cut(JSON.stringify(await req("get", { path: String(input.path ?? "") }))) }),
    },
    {
      risk: "write",
      spec: {
        name: "godot_edit",
        description: "Change the open scene, one undo step per change. ops: [{op:\"add\", parent, type (a node class or res://scene.tscn), name} | {op:\"set\", path, property, value} | {op:\"remove\", path} | {op:\"attach_script\", path, script:\"res://…\"}]. Then godot_scene save.",
        inputSchema: { type: "object", properties: { ops: { type: "array", items: { type: "object" } } }, required: ["ops"] },
      },
      preview: async (input) => JSON.stringify(input.ops ?? [], null, 1).slice(0, 2000),
      run: async (input) => {
        const ops = Array.isArray(input.ops) ? (input.ops as Array<Record<string, unknown>>).slice(0, 50) : [];
        const lines: string[] = [];
        for (const o of ops) {
          const op = String(o.op ?? "");
          if (!["add", "set", "remove", "attach_script"].includes(op)) {
            lines.push(`✗ ${op}: unknown op`);
            continue;
          }
          const { op: _op, ...args } = o;
          lines.push(await req(op, args).then((r) => `✓ ${op} ${JSON.stringify(r)}`, (e: Error) => `✗ ${op}: ${e.message}`));
        }
        return { output: cut(lines.join("\n") || "No ops.") };
      },
    },
    {
      risk: "write",
      spec: { name: "godot_scene", description: "action new (scene res://….tscn, root type), open (scene) or save (the open scene).", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["new", "open", "save"] }, scene: { type: "string" }, root: { type: "string" } }, required: ["action"] } },
      run: async (input) => {
        const a = String(input.action);
        const r = a === "new" ? await req("new_scene", { scene: input.scene, root: input.root ?? "Node2D" }) : a === "open" ? await req("open", { scene: input.scene }) : await req("save");
        return { output: `${a}: ${JSON.stringify(r)}` };
      },
    },
    {
      risk: "write",
      spec: {
        name: "godot_file",
        description: "Read, write or list project files under res:// (GDScript .gd, C# .cs, shaders, scenes). action read (file), write (file, text: the whole file), list.",
        inputSchema: { type: "object", properties: { action: { type: "string", enum: ["read", "write", "list"] }, file: { type: "string" }, text: { type: "string" } }, required: ["action"] },
      },
      preview: async (input) => (input.action === "write" ? `Write ${String(input.file)}:\n${String(input.text ?? "").slice(0, 3000)}` : `${String(input.action)} ${String(input.file ?? "")}`),
      run: async (input) => {
        const a = String(input.action);
        if (a === "list") return { output: cut(((await req<{ files: string[] }>("files")).files ?? []).join("\n")) };
        if (a === "read") return { output: cut((await req<{ text: string }>("read", { file: input.file })).text) };
        await req("write", { file: input.file, text: String(input.text ?? "") });
        return { output: `Wrote ${String(input.file)}.` };
      },
    },
    {
      risk: "write",
      spec: { name: "godot_run", description: "Run the game from the editor: the main scene, the open scene (current true) or a scene (res://…).", inputSchema: { type: "object", properties: { current: { type: "boolean" }, scene: { type: "string" } } } },
      run: async (input) => {
        await req("run", { ...(input.current ? { current: true } : {}), ...(input.scene ? { scene: input.scene } : {}) });
        return { output: "Running. Read godot_log after a few seconds, then godot_stop." };
      },
    },
    {
      risk: "safe",
      spec: { name: "godot_stop", description: "Stop the running game.", inputSchema: { type: "object", properties: {} } },
      run: async () => ({ output: `Stopped: ${JSON.stringify(await req("stop"))}` }),
    },
    {
      risk: "read",
      spec: { name: "godot_log", description: "The end of the game's log (errors and print output of the last run).", inputSchema: { type: "object", properties: {} } },
      run: async () => ({ output: cut((await req<{ text: string }>("log")).text || "(empty)") }),
    },
    {
      risk: "read",
      spec: { name: "godot_screenshot", description: "A picture of the editor's 2D or 3D view, shown in the chat.", inputSchema: { type: "object", properties: { view: { type: "string", enum: ["2d", "3d"] } } } },
      run: async (input) => {
        const r = await req<{ png: string }>("screenshot", { view: input.view === "3d" ? "3d" : "2d" }, 20_000);
        const id = await saveImage(Buffer.from(r.png, "base64"));
        return { output: "The editor view is shown to the user.", assetIds: [id] };
      },
    },
  ];
}
