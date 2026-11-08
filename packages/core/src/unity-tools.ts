import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@kesher/agent";
import type { UnityCli } from "./unity-cli.js";

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

/** The workflow, for the model (Unity's own guidance for agents, in short). */
export const UNITY_NOTE =
  "Unity tools (Unity's CLI, on the user's Unity project): 1) unity_status first: is an Editor open and \"ready\" (if Safe Mode, read the compile errors it lists and fix the scripts). 2) unity_find_commands with a word (\"playmode\", \"screenshot\", \"gameobject\", \"console\") to get the exact command and its parameters — never guess names or flags. 3) unity_command to run it in the open Editor (fast, Ctrl+Z works in Unity). 4) unity_script_eval for anything without a command (C#, e.g. `new UnityEngine.GameObject(\"Door\");` or `return Application.unityVersion;`). 5) unity_screenshot to look at the Game or Scene view and check your work. To test a game: `editor set_auto_tick` first (else an unfocused Editor freezes at frame 1), then `editor.playmode start`, check frames advance, screenshot, read the console, `editor.playmode stop`. If the user is already playing, only read. Make scene and asset changes through these tools, not by editing .unity or .prefab files by hand.";

/**
 * @param unity - The Unity CLI service (the page's active project).
 * @param outputsDir - Where screenshots are saved for the user.
 * @param saveAsset - Keeps a picture in the library; returns its id.
 */
export function unityTools(unity: UnityCli, outputsDir: string, saveAsset: (data: Uint8Array, mimeType: string) => Promise<string>): AgentTool[] {
  const project = () => unity.activeProject;
  const at = (): string[] => (project() ? ["--project-path", project()!] : []);
  const need = () => {
    if (!project()) throw new Error("No Unity project is chosen yet. Tell the user to open Create → Unity Visual Scripting and add a project, or make a new one there (New project).");
  };
  return [
    {
      risk: "read",
      spec: {
        name: "unity_status",
        description: "Whether a Unity Editor is open on the user's project and ready for commands (or in Safe Mode, with its compile errors). Call it before other Unity tools.",
        inputSchema: { type: "object", properties: {} },
      },
      run: async () => ({ output: cut(`Project: ${project() ?? "(none chosen)"}\n${await unity.cli(["status", ...at(), "--format", "json"], 20_000).catch((e: Error) => e.message)}`) }),
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
        let file = join(outputsDir, `unity-${Date.now()}.png`);
        if (view === "game") await unity.cli(["command", "capture", "screenshot", ...at(), "--result-only", "--", "--output", file], 60_000);
        else {
          // The Scene view's command saves inside the project (a project-relative path).
          const rel = `Temp/kesher-scene-${Date.now()}.png`;
          await unity.cli(["command", "capture", "scene_view", ...at(), "--result-only", "--", "--save_path", rel], 60_000);
          file = join(project()!, rel);
        }
        const data = await readFile(file);
        const id = await saveAsset(data, "image/png");
        return { output: `Took a picture of the ${view} view.`, assetIds: [id], images: [{ mimeType: "image/png", data: data.toString("base64") }] };
      },
    },
  ];
}
