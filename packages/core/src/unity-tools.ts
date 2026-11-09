import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentTool } from "@kesher/agent";
import { readResult, type UnityCli } from "./unity-cli.js";

/**
 * Unity in the chat, through Unity's own CLI (`unity`), the way Unity
 * documents it for AI agents: check the Editor is connected
 * (`unity status`), find the right command (`unity command --query`), run
 * it in the open Editor (`unity command <group> <name> -- --flag value`,
 * about half a second, no recompile), run C# (`script eval`), and look at
 * the result (a Game/Scene view screenshot). Commands come from the
 * project's Pipeline package, so the tools find them instead of guessing.
 *
 * Safety: arguments go to the CLI as a list (never a shell); command names
 * and flag names are checked; changing commands and C# ask the user first
 * (like any command); reading tools run without asking.
 */

const MAX_OUT = 8000;
const cut = (s: string) => (s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n… (cut: ${s.length - MAX_OUT} more characters)` : s);
const WORDS = /^[a-z0-9_.-]{1,60}( [a-z0-9_.-]{1,60}){0,3}$/i;
const FLAG = /^[a-z_][a-z0-9_-]{0,60}$/i;

/** The tools that tool search must never hide while a Unity project is in use. */
export const UNITY_TOOL_NAMES = [
  "unity_status",
  "unity_list_scripts",
  "unity_read_script",
  "unity_write_script",
  "unity_recompile",
  "unity_console",
  "unity_scene",
  "unity_create_gameobject",
  "unity_add_component",
  "unity_find_commands",
  "unity_command",
  "unity_script_eval",
  "unity_screenshot",
  "unity_build",
] as const;

/** The workflow, for the model (Unity's own guidance for agents, in short). */
export const UNITY_NOTE =
  "Unity tools work directly on the user's open Unity project through Unity's CLI. NEVER say you made, wrote, built or changed something in Unity unless a tool result in this chat shows it happened; if a tool fails, say so plainly. Do not make a build or a new folder unless the user asks for a build. The loop: 1) unity_status: is the Editor open and ready (in Safe Mode read the compile errors and fix them). 2) unity_list_scripts / unity_read_script / unity_scene (hierarchy) to see what exists. 3) unity_write_script writes C# into Assets/ and compiles it at once: if it reports errors, fix them and write again until it compiles. 4) unity_create_gameobject and unity_add_component put things in the scene (your new scripts too), then unity_scene save. 5) unity_console for errors and logs; unity_screenshot to look. 6) unity_find_commands + unity_command for anything else the Editor offers (exact names only, never guessed); unity_script_eval for short C# with no command. To test a game: unity_command 'editor set_auto_tick' first, then 'editor.playmode start', screenshot and console, then 'editor.playmode stop'. Change scenes and prefabs through these tools, never by editing .unity or .prefab text. The project's files are reached ONLY through the unity_* tools (list_files, read_file and run_command do not see the project); unity_write_script makes missing folders itself. For materials, prefabs and other assets use unity_script_eval with UnityEditor.AssetDatabase (e.g. AssetDatabase.CreateAsset, PrefabUtility.SaveAsPrefabAsset). Prefer 2D components (SpriteRenderer, BoxCollider2D) in 2D projects; a primitive already has a MeshRenderer and a 3D collider. A sprite made in code from a small texture needs pixelsPerUnit equal to the texture size (Sprite.Create(tex, rect, new Vector2(0.5f, 0.5f), tex.width)), else it is 100 times too small and nothing shows. Compiling is not proof the game works: in play mode take a game-view screenshot and check the board, pieces and text really show before saying it works; if you cannot see pictures, read the hierarchy and positions in play mode instead. When the user asks for a game they can run, unity_build (after saving the scene). At the end, list exactly what changed (files and scene objects).";

const MAX_TEXT = 300_000;
const CODE_EXT = /\.(cs|shader|hlsl|cginc|compute|uss|uxml|tss|asmdef|asmref)$/i;
const READ_ROOTS = ["Assets", "Packages", "ProjectSettings"];
const TYPE = /^[A-Za-z_][A-Za-z0-9_.]{0,120}$/;
const BUILD_TARGETS: Record<string, { id: string; folder: string; ext: string }> = {
  windows: { id: "StandaloneWindows64", folder: "Windows", ext: ".exe" },
  mac: { id: "StandaloneOSX", folder: "Mac", ext: ".app" },
  linux: { id: "StandaloneLinux64", folder: "Linux", ext: ".x86_64" },
  webgl: { id: "WebGL", folder: "WebGL", ext: "/" },
  android: { id: "Android", folder: "Android", ext: ".apk" },
};
const PRIMITIVES = ["Cube", "Sphere", "Capsule", "Cylinder", "Plane", "Quad"] as const;

/** A C# string literal for any text (quotes and backslashes escaped, control characters dropped). */
export function csString(text: string): string {
  const clean = [...text].filter((ch) => ch.charCodeAt(0) >= 32).join("");
  return `"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * A path inside the Unity project, checked: relative to the project (or an
 * absolute path inside it), under one of `roots`, no `..` escape, and no
 * symbolic link leading outside.
 *
 * @returns The absolute path and the project-relative one with forward slashes.
 * @throws Error in plain words when the path is not allowed.
 */
export function projectPath(project: string, given: string, roots: readonly string[]): { abs: string; rel: string } {
  const raw = String(given ?? "").trim().replace(/\\/g, "/");
  if (!raw || raw.length > 400 || raw.includes("\0")) throw new Error("Give a path inside the Unity project, like Assets/Scripts/Player.cs.");
  const abs = resolve(project, isAbsolute(raw) ? raw : raw.replace(/^\/+/, ""));
  const rel = relative(project, abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${given} is outside the Unity project.`);
  if (!roots.some((r) => rel === r || rel.startsWith(`${r}/`))) throw new Error(`Only ${roots.join(", ")} can be used here (got ${rel}).`);
  // Follow links on the part that exists: it must still be inside the project.
  let probe = abs;
  while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
  const realProject = realpathSync(project);
  const real = realpathSync(probe);
  const back = relative(realProject, real);
  if (back.startsWith("..") || isAbsolute(back)) throw new Error(`${given} leads outside the Unity project.`);
  return { abs, rel };
}

/** Plain words for `unity recompile --format json` (exit 0 = compiles). */
function compileReport(code: number, out: string, err: string): string {
  const text = `${out}\n${err}`.trim();
  if (code === 0) return `Compiled with no errors.${/warning/i.test(text) ? `\n${cut(text)}` : ""}`;
  if (code === 7 || /EDITOR_NOT_RUNNING|no (running|open) editor|could not connect|not connected/i.test(text))
    return "No open Unity Editor answered, so the code was NOT compiled yet. Ask the user to open the project in Unity (or check unity_status: Safe Mode lists compile errors), then run unity_recompile.";
  return `Compile errors (fix them, then write the script again):\n${cut(text)}`;
}

/**
 * @param unity - The Unity CLI service (the page's active project).
 * @param outputsDir - Where screenshots are saved for the user.
 * @param saveAsset - Keeps a picture in the library; returns its id.
 */
export function unityTools(unity: UnityCli, outputsDir: string, saveAsset: (data: Uint8Array, mimeType: string) => Promise<string>): AgentTool[] {
  const project = () => unity.activeProject;
  const at = (): string[] => (project() ? ["--project-path", project()!] : []);
  const need = () => {
    if (!project()) throw new Error("No Unity project is chosen yet. Tell the user to press + → Project in the message box and pick the Unity project folder (or Create → Unity → Add a project), or make a new one there (New project).");
  };
  // C# in the open Editor through the Pipeline's script eval; its returned text comes back.
  const evalCs = async (code: string): Promise<string> => {
    const r = await unity.cliRaw(["command", "script", "eval", ...at(), "--result-only", "--timeout", "60", "--", code], 90_000);
    if (r.code !== 0) return `Unity did not run it: ${unity.explain(r)} (is the Editor open and ready? unity_status)`;
    const v = readResult(r.stdout);
    // script eval answers {output, diagnostics, success, result}: the model needs the result (or the errors).
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as { result?: unknown; success?: boolean; diagnostics?: unknown[]; output?: unknown };
      if (o.success === false || (Array.isArray(o.diagnostics) && o.diagnostics.length)) return `C# failed in Unity: ${JSON.stringify(o.diagnostics ?? o.output ?? o)}`;
      if ("result" in o) return typeof o.result === "string" ? o.result : JSON.stringify(o.result ?? "Done.");
    }
    return typeof v === "string" ? v : JSON.stringify(v ?? "Done.");
  };
  return [
    {
      risk: "read",
      spec: {
        name: "unity_status",
        description: "Whether a Unity Editor is open on the user's project and ready for commands (or in Safe Mode, with its compile errors). Call it before other Unity tools.",
        inputSchema: { type: "object", properties: {} },
      },
      run: async () => {
        const p = project();
        const pk = p ? unity.packagesOf(p) : undefined;
        const missing = pk && !pk.pipeline ? "\nThe project does NOT have Unity's Pipeline package, so no Editor commands work yet: tell the user to press 🕹 → Install now in the message box (or Create → Unity → Add to a project)." : "";
        return { output: cut(`Project: ${p ?? "(none chosen)"}${missing}\n${await unity.cli(["status", ...at(), "--json"], 20_000).catch((e: Error) => e.message)}`) };
      },
    },
    {
      risk: "read",
      spec: {
        name: "unity_list_scripts",
        description: "List the project's code files (C#, shaders, UI Toolkit, assembly definitions) under Assets/ or a folder in it, with sizes.",
        inputSchema: { type: "object", properties: { folder: { type: "string", description: "Default Assets." } } },
      },
      run: async (input) => {
        need();
        const { abs, rel } = projectPath(project()!, String(input.folder ?? "Assets") || "Assets", ["Assets"]);
        const out: string[] = [];
        const walk = async (dir: string, depth: number): Promise<void> => {
          if (out.length >= 500 || depth > 12) return;
          const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const e of entries) {
            if (out.length >= 500) return;
            if (e.name.startsWith(".") || e.name.endsWith("~")) continue;
            const p = join(dir, e.name);
            if (e.isDirectory()) await walk(p, depth + 1);
            else if (e.isFile() && CODE_EXT.test(e.name)) out.push(`${relative(project()!, p).replace(/\\/g, "/")} (${(await stat(p)).size} bytes)`);
          }
        };
        await walk(abs, 0);
        return { output: out.length ? `${out.join("\n")}${out.length >= 500 ? "\n… (first 500)" : ""}` : `No code files under ${rel} yet.` };
      },
    },
    {
      risk: "read",
      spec: {
        name: "unity_read_script",
        description: "Read a text file of the Unity project (a script, shader, .asmdef, Packages/manifest.json, ProjectSettings…) by its project path, e.g. Assets/Scripts/Player.cs.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      run: async (input) => {
        need();
        const { abs, rel } = projectPath(project()!, String(input.path ?? ""), READ_ROOTS);
        if (/\.(unity|prefab|asset)$/i.test(rel)) return { output: "Scenes, prefabs and assets are not read as text: use unity_scene (hierarchy) or the Editor's commands." };
        const s = await stat(abs).catch(() => undefined);
        if (!s?.isFile()) return { output: `There is no file ${rel}.` };
        if (s.size > MAX_TEXT) return { output: `${rel} is too big to read here (${s.size} bytes).` };
        return { output: cut(await readFile(abs, "utf8")) };
      },
    },
    {
      risk: "write",
      spec: {
        name: "unity_write_script",
        description: "Create or replace a code file in the project's Assets/ (C#, shader, USS/UXML, .asmdef) with its full content, then compile at once in the open Editor and return the compile errors, if any. The class name of a MonoBehaviour must match the file name.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Inside Assets/, e.g. Assets/Scripts/PlayerMovement.cs." },
            content: { type: "string", description: "The whole file." },
          },
          required: ["path", "content"],
        },
      },
      preview: async (input) => {
        const p = project();
        let target = String(input.path ?? "");
        try {
          if (p) target = projectPath(p, target, ["Assets"]).rel;
        } catch {
          // shown as given; run() refuses it
        }
        const lines = String(input.content ?? "").split("\n");
        return `Write ${target} in ${p ?? "(no project)"} (${lines.length} lines):\n${lines.slice(0, 120).join("\n")}${lines.length > 120 ? "\n…" : ""}`;
      },
      run: async (input, ctx) => {
        need();
        const content = String(input.content ?? "");
        const { abs, rel } = projectPath(project()!, String(input.path ?? ""), ["Assets"]);
        if (!CODE_EXT.test(rel)) return { output: "Only code files can be written here (.cs, .shader, .hlsl, .cginc, .compute, .uss, .uxml, .tss, .asmdef, .asmref)." };
        if (!content.trim()) return { output: "The content is empty: give the whole file." };
        if (content.length > MAX_TEXT) return { output: "That file is too big (over 300,000 characters): split it." };
        const before = await readFile(abs, "utf8").catch(() => null);
        await mkdir(dirname(abs), { recursive: true });
        ctx.recordChange(abs, before);
        await writeFile(abs, content, "utf8");
        const written = (await stat(abs)).size;
        const head = `${before === null ? "Created" : "Updated"} ${rel} (${written} bytes, on disk now).`;
        if (!/\.(cs|asmdef|asmref)$/i.test(rel)) return { output: `${head} Unity imports it when the Editor has focus or on the next refresh.` };
        const r = await unity.cliRaw(["recompile", "--project-path", project()!, "--format", "json"], 240_000).catch((e: Error) => ({ code: -1, stdout: "", stderr: e.message }));
        return { output: `${head}\n${compileReport(r.code, r.stdout, r.stderr)}` };
      },
    },
    {
      risk: "read",
      spec: {
        name: "unity_recompile",
        description: "Compile the project's scripts in the open Unity Editor now and return the errors and warnings (like a type check; no build).",
        inputSchema: { type: "object", properties: {} },
      },
      run: async () => {
        need();
        const r = await unity.cliRaw(["recompile", "--project-path", project()!, "--format", "json"], 240_000);
        return { output: compileReport(r.code, r.stdout, r.stderr) };
      },
    },
    {
      risk: "read",
      spec: {
        name: "unity_console",
        description: "The latest entries of the open Unity Editor's Console (errors, warnings, Debug.Log), newest last.",
        inputSchema: {
          type: "object",
          properties: { level: { type: "string", enum: ["error", "warn", "info"], description: "error = errors only; warn = warnings and errors; info = everything (default)." }, count: { type: "number", description: "Default 30, at most 200." } },
        },
      },
      run: async (input) => {
        need();
        const level = ["error", "warn", "info"].includes(String(input.level)) ? String(input.level) : "info";
        const n = Math.min(200, Math.max(1, Math.round(Number(input.count ?? 30)) || 30));
        const r = await unity.cliRaw(["logs", "--console", "--level", level, "--tail", String(n), "--project-path", project()!, "--format", "json"], 30_000);
        if (r.code !== 0) return { output: `Could not read the Console: ${unity.explain(r)}` };
        return { output: cut(r.stdout.trim() || "The Console is empty.") };
      },
    },
    {
      risk: "write",
      spec: {
        name: "unity_scene",
        description: "The open scene: action 'hierarchy' lists its GameObjects with their components; 'save' saves it (give path, e.g. Assets/Scenes/Main.unity, for a new unsaved scene).",
        inputSchema: { type: "object", properties: { action: { type: "string", enum: ["hierarchy", "save"] }, path: { type: "string" } }, required: ["action"] },
      },
      run: async (input) => {
        need();
        if (input.action === "save") {
          let target = "";
          if (input.path) {
            const { rel } = projectPath(project()!, String(input.path), ["Assets"]);
            if (!/\.unity$/i.test(rel)) return { output: "A scene path ends in .unity." };
            target = rel;
          }
          return { output: await evalCs(SAVE_SCENE(target)) };
        }
        return { output: cut(await evalCs(HIERARCHY)) };
      },
    },
    {
      risk: "write",
      spec: {
        name: "unity_create_gameobject",
        description: "Add a GameObject to the open scene (one undo step in Unity): a name, optionally a primitive shape, a parent path (e.g. 'Level/Enemies'), a position, and components by type name (built-in like Rigidbody, BoxCollider, or the project's own scripts after they compile).",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            primitive: { type: "string", enum: [...PRIMITIVES] },
            parent: { type: "string" },
            position: { type: "array", items: { type: "number" }, description: "[x, y, z]" },
            components: { type: "array", items: { type: "string" } },
          },
          required: ["name"],
        },
      },
      run: async (input) => {
        need();
        const name = String(input.name ?? "").trim().slice(0, 120) || "GameObject";
        const prim = PRIMITIVES.find((p) => p === input.primitive);
        const comps = toTypes(input.components);
        if (typeof comps === "string") return { output: comps };
        const pos = Array.isArray(input.position) ? input.position.map(Number) : [];
        if (pos.length && (pos.length !== 3 || !pos.every(Number.isFinite))) return { output: "position is [x, y, z] numbers." };
        const code = `${FIND_TYPE}
var go = ${prim ? `UnityEngine.GameObject.CreatePrimitive(UnityEngine.PrimitiveType.${prim})` : "new UnityEngine.GameObject()"};
go.name = ${csString(name)};
UnityEditor.Undo.RegisterCreatedObjectUndo(go, "KesherAI: create " + go.name);
${input.parent ? `var parent = UnityEngine.GameObject.Find(${csString(String(input.parent).slice(0, 300))});
if (parent == null) { UnityEngine.Object.DestroyImmediate(go); return "No GameObject at ${String(input.parent).replace(/[^\w /.-]/g, "")} in the open scene; nothing was added."; }
UnityEditor.Undo.SetTransformParent(go.transform, parent.transform, "KesherAI: parent");` : ""}
${pos.length ? `go.transform.localPosition = new UnityEngine.Vector3(${pos.map((n) => `${n}f`).join(", ")});` : ""}
${ADD_COMPONENTS(comps)}
UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
UnityEditor.Selection.activeGameObject = go;
return "Added " + PathOf(go.transform) + report + " (not saved yet: unity_scene save).";`;
        return { output: await evalCs(code) };
      },
    },
    {
      risk: "write",
      spec: {
        name: "unity_add_component",
        description: "Add components (by type name: Rigidbody2D, AudioSource, or the project's own compiled scripts) to an existing GameObject of the open scene, found by its path like 'Player' or 'Level/Door'.",
        inputSchema: { type: "object", properties: { gameObject: { type: "string" }, components: { type: "array", items: { type: "string" } } }, required: ["gameObject", "components"] },
      },
      run: async (input) => {
        need();
        const comps = toTypes(input.components);
        if (typeof comps === "string") return { output: comps };
        if (!comps.length) return { output: "Name at least one component." };
        const path = String(input.gameObject ?? "").slice(0, 300);
        const code = `${FIND_TYPE}
var go = UnityEngine.GameObject.Find(${csString(path)});
if (go == null) return "No GameObject at that path in the open scene (see unity_scene hierarchy); nothing changed.";
${ADD_COMPONENTS(comps)}
UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
return "Changed " + PathOf(go.transform) + report + " (not saved yet: unity_scene save).";`;
        return { output: await evalCs(code) };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "unity_build",
        description: "Build the Unity project into a game the user can run (Unity's CLI `unity build`; through the open Editor when it is open). Save the scene first. Only when the user asks for a build. The result goes to <project>/Builds/<target>/.",
        inputSchema: {
          type: "object",
          properties: { target: { type: "string", enum: ["windows", "mac", "linux", "webgl", "android"], description: "Default windows." }, name: { type: "string", description: "The game's file name (default: the project's name)." } },
        },
      },
      preview: async (input) => `unity build ${project() ?? "(no project)"} --target ${String(input.target ?? "windows")}`,
      run: async (input) => {
        need();
        const p = project()!;
        const target = BUILD_TARGETS[String(input.target ?? "windows")] ?? BUILD_TARGETS.windows!;
        const name = (String(input.name ?? "").replace(/[^\w -]/g, "").trim() || p.split(/[\\/]/).pop() || "Game").slice(0, 60);
        const folder = join(p, "Builds", target.folder);
        await mkdir(folder, { recursive: true });
        const out = target.ext === "/" ? folder : join(folder, `${name}${target.ext}`);
        // The open Editor's own build command first (Pipeline `build run`): `unity build` 1.0.0-beta through
        // Pipeline 0.10 sends an option the Editor rejects. With Unity closed, `unity build` runs a batch Editor.
        // No scene in Build Settings (a new project): the open scene is added, so the build has something to build.
        await evalCs("var list = new System.Collections.Generic.List<UnityEditor.EditorBuildSettingsScene>(UnityEditor.EditorBuildSettings.scenes); bool any = false; foreach (var s in list) if (s.enabled) any = true; if (!any) { var a = UnityEngine.SceneManagement.SceneManager.GetActiveScene().path; if (a != \"\") { list.Add(new UnityEditor.EditorBuildSettingsScene(a, true)); UnityEditor.EditorBuildSettings.scenes = list.ToArray(); return \"added \" + a; } } return \"ok\";").catch(() => "");
        let r = await unity.cliRaw(["command", "build", "run", ...at(), "--timeout", "3600", "--", "--target", target.id, "--output-path", out, "--confirm", "true"], 3_700_000);
        // The Editor queues the build and answers at once ("status: queued"): wait for it with `build status`.
        if (r.code === 0 && /queued|running|building|in.?progress/i.test(r.stdout)) {
          for (let i = 0; i < 720; i++) {
            await new Promise((res) => setTimeout(res, 5000));
            const st = await unity.cliRaw(["command", "build", "status", ...at(), "--result-only"], 30_000).catch(() => undefined);
            const text = st?.code === 0 ? st.stdout : "";
            const busy = /queued|running|building|in.?progress/i.test(text);
            if (text && !busy && /succeeded|success|completed|finished|done/i.test(text)) {
              r = { code: 0, stdout: text, stderr: "" };
              break;
            }
            if (text && !busy && /failed|cancel/i.test(text)) {
              r = { code: 1, stdout: text, stderr: "" };
              break;
            }
            // No readable status: the game file appearing and the Editor idle again is enough.
            if (!text && existsSync(out) && i > 2) {
              r = { code: 0, stdout: "The game file is there.", stderr: "" };
              break;
            }
          }
        }
        if (r.code !== 0 && !existsSync(out) && !/buildId|build status/i.test(r.stdout)) r = await unity.cliRaw(["build", p, "--target", target.id, "--output-path", out, "--timeout", "3600", "--format", "json"], 3_700_000);
        const made = existsSync(out);
        if (r.code !== 0 || !made) return { output: `The build did NOT finish (exit ${r.code}). ${made ? "" : "No game file was made. "}Unity said:\n${cut(`${r.stdout}\n${r.stderr}`.trim())}` };
        const size = (await stat(out)).isFile() ? `${Math.round((await stat(out)).size / 1024)} KB` : "a folder";
        return { output: `Built ${target.id}: ${out} (${size}). The user can run it from there.\n${cut(r.stdout.trim())}` };
      },
    },
    {
      risk: "read",
      spec: {
        name: "unity_find_commands",
        description: "Search the commands the open Unity Editor (and Unity's CLI) offers, with their parameters: e.g. 'playmode', 'screenshot', 'create gameobject', 'console', 'material'. Use the exact names it returns in unity_command.",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      run: async (input) => {
        const q = String(input.query ?? "").replace(/[^\p{L}\p{N} _.-]/gu, " ").trim().slice(0, 80);
        if (!q) return { output: "Give a word to search for." };
        const out = await unity.cli(["command", "--query", q, ...at(), "--format", "json"], 30_000).catch(async () => unity.cli(["commands", "--grep", q, "--format", "json"], 30_000));
        return { output: cut(out) };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "unity_command",
        description: "Run one command in the open Unity Editor (from unity_find_commands), e.g. command 'editor.playmode start', or 'console write' with args {message: 'Hi'}. Array values are sent as JSON text. Changes show in Unity at once and can be undone there.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Its group and name, as unity_find_commands shows them, e.g. 'editor.playmode start'." },
            args: { type: "object", description: "Its parameters by name, e.g. { \"name\": \"Door\" }." },
            timeoutSeconds: { type: "number", description: "Default 60." },
          },
          required: ["command"],
        },
      },
      preview: async (input) => `unity command ${String(input.command ?? "")}${input.args ? ` ${JSON.stringify(input.args)}` : ""}\nproject: ${project() ?? "(none)"}`,
      run: async (input) => {
        need();
        const command = String(input.command ?? "").trim();
        if (!WORDS.test(command)) return { output: "That is not a command name: use the group and name from unity_find_commands (letters, numbers, _ . -)." };
        const flags: string[] = [];
        for (const [k, v] of Object.entries((input.args ?? {}) as Record<string, unknown>)) {
          if (!FLAG.test(k)) return { output: `"${k}" is not a parameter name.` };
          flags.push(`--${k}`, typeof v === "string" ? v : JSON.stringify(v));
        }
        const secs = Math.min(600, Math.max(5, Number(input.timeoutSeconds ?? 60) || 60));
        // Unity's own flags first; the command's flags after "--", so a parameter named like a CLI flag is not swallowed.
        const out = await unity.cli(["command", ...command.split(" "), ...at(), "--result-only", "--timeout", String(secs), ...(flags.length ? ["--", ...flags] : [])], (secs + 10) * 1000);
        return { output: cut(out || "Done.") };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "unity_script_eval",
        description: "Run C# in the open Unity Editor (UnityEngine and UnityEditor available) and get what it returns, for anything no command does. Keep it short; it runs on the user's project.",
        inputSchema: { type: "object", properties: { code: { type: "string", description: "C# statements; `return x;` sends a value back." } }, required: ["code"] },
      },
      preview: async (input) => `C# in Unity (${project() ?? "no project"}):\n${String(input.code ?? "")}`,
      run: async (input) => {
        need();
        const code = String(input.code ?? "");
        if (!code.trim() || code.length > 20_000) return { output: "Give C# code (under 20,000 characters)." };
        return { output: cut((await unity.cli(["command", "script", "eval", ...at(), "--result-only", "--", code], 90_000)) || "Done.") };
      },
    },
    {
      risk: "read",
      spec: {
        name: "unity_screenshot",
        description: "A picture of the Unity Editor's Game view (or the Scene view) to check your work; you and the user see it.",
        inputSchema: { type: "object", properties: { view: { type: "string", enum: ["game", "scene"] } } },
      },
      run: async (input) => {
        need();
        await mkdir(outputsDir, { recursive: true });
        const view = input.view === "scene" ? "scene" : "game";
        const file = join(outputsDir, `unity-${view}-${Date.now()}.png`);
        // Pipeline 0.10+: `capture screenshot --view game|scene --output-path <file>`; older: --output (game) / scene_view --save_path.
        const r = await unity.cliRaw(["command", "capture", "screenshot", ...at(), "--result-only", "--", "--view", view, "--output-path", file], 60_000);
        if (r.code !== 0 || !existsSync(file)) {
          if (view === "game") await unity.cli(["command", "capture", "screenshot", ...at(), "--result-only", "--", "--output", file], 60_000);
          else {
            const rel = `Temp/kesher-scene-${Date.now()}.png`;
            await unity.cli(["command", "capture", "scene_view", ...at(), "--result-only", "--", "--save_path", rel], 60_000);
            await writeFile(file, await readFile(join(project()!, rel)));
          }
        }
        const data = await readFile(file);
        const id = await saveAsset(data, "image/png");
        return { output: `Took a picture of the ${view} view.`, assetIds: [id], images: [{ mimeType: "image/png", data: data.toString("base64") }] };
      },
    },
  ];
}

/** Checks component type names. @returns The names, or a plain-words refusal. */
function toTypes(list: unknown): string[] | string {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 20) return "components is a list of up to 20 type names.";
  const names = list.map((x) => String(x).trim());
  const bad = names.find((n) => !TYPE.test(n));
  return bad ? `"${bad}" is not a component type name.` : names;
}

// Finds a Component type by full or short name in every loaded assembly (UnityEngine first).
const FIND_TYPE = `System.Func<string, System.Type> FindType = n => {
  var direct = System.Type.GetType("UnityEngine." + n + ", UnityEngine") ?? System.Type.GetType(n);
  if (direct != null && typeof(UnityEngine.Component).IsAssignableFrom(direct)) return direct;
  foreach (var a in System.AppDomain.CurrentDomain.GetAssemblies()) {
    System.Type[] ts; try { ts = a.GetTypes(); } catch (System.Reflection.ReflectionTypeLoadException e) { ts = e.Types; }
    foreach (var t in ts) if (t != null && (t.FullName == n || t.Name == n) && typeof(UnityEngine.Component).IsAssignableFrom(t) && !t.IsAbstract) return t;
  }
  return null;
};
System.Func<UnityEngine.Transform, string> PathOf = null;
PathOf = t => t.parent == null ? t.name : PathOf(t.parent) + "/" + t.name;
var report = "";`;

const ADD_COMPONENTS = (names: string[]) =>
  names
    .map(
      (n) => `{ var t = FindType(${csString(n)});
  if (t == null) report += "; no component type ${n} (if it is a new script, it must compile first)";
  else if (go.GetComponent(t) != null && t.GetCustomAttributes(typeof(UnityEngine.DisallowMultipleComponent), true).Length > 0) report += "; already has ${n}";
  else { var c = UnityEditor.Undo.AddComponent(go, t); report += c != null ? "; added ${n}" : "; Unity refused ${n}"; } }`,
    )
    .join("\n");

const HIERARCHY = `var sb = new System.Text.StringBuilder(); var count = 0;
var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
sb.AppendLine("Scene: " + (scene.path == "" ? "(new, never saved)" : scene.path) + (scene.isDirty ? " (unsaved changes)" : ""));
System.Action<UnityEngine.Transform, int> walk = null;
walk = (t, d) => {
  if (count++ >= 400) return;
  var parts = new System.Collections.Generic.List<string>();
  foreach (var c in t.GetComponents<UnityEngine.Component>()) { if (c == null) parts.Add("Missing script"); else if (!(c is UnityEngine.Transform)) parts.Add(c.GetType().Name); }
  sb.AppendLine(new string(' ', d * 2) + t.name + (t.gameObject.activeSelf ? "" : " (inactive)") + (parts.Count > 0 ? " [" + string.Join(", ", parts) + "]" : ""));
  if (d < 10) foreach (UnityEngine.Transform ch in t) walk(ch, d + 1);
};
foreach (var r in scene.GetRootGameObjects()) walk(r.transform, 0);
if (count >= 400) sb.AppendLine("… (first 400 objects)");
return sb.ToString();`;

const SAVE_SCENE = (path: string) => `var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
var target = ${csString(path)};
if (target == "") target = scene.path;
if (target == "") target = "Assets/Scenes/Main.unity";
System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(target));
var ok = UnityEditor.SceneManagement.EditorSceneManager.SaveScene(scene, target);
return ok ? "Saved the scene to " + target + "." : "Unity did not save the scene.";`;
