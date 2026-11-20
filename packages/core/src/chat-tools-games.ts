/**
 * The game-engine tools a chat gets (docs/ARCHITECTURE_REVIEW.md C2): Unity through its CLI, Unreal (its own tools,
 * and its Blueprints in words through the KesherAI Bridge), the Visual Scripting graphs, and running a game's Android
 * build on the user's phone. Few tokens until a project is in use: then the full set and its guide come.
 */
import { basename, dirname, join } from "node:path";
import type { AgentTool } from "@kesher/agent";
import { androidPhoneTools } from "./android-phone.js";
import type { ConversationDeps } from "./conversation-deps.js";
import { graphTools } from "./graph-edit.js";
import type { JobStore } from "./jobs.js";
import { BUILD_RESEARCH_NOTE } from "./known-issues.js";
import { chosenPhones, phoneNote, type Phone } from "./phones.js";
import { UNITY_NOTE, unityTools } from "./unity-tools.js";
import { unityTurns } from "./unity-turns.js";
import { UNREAL_NOTE, unrealTools } from "./unreal-tools.js";
import { GODOT_IDLE_NOTE, GODOT_NOTE, godotTools } from "./godot-tools.js";
import { MOD_NOTE, modTools } from "./game-mods.js";
import { VERSE_NOTE, uefnTools } from "./uefn-tools.js";
import { existsSync } from "node:fs";
import { gameFindTool } from "./game-index.js";
import { findGameProjects } from "./game-projects.js";
import { homedir } from "node:os";
import type { GameCheckpoints, GameEngine } from "./game-checkpoints.js";
import { unityAssetFile, unrealAssetFile, unrealLevelFile } from "./game-sync.js";
import { unrealLevelTools } from "./unreal-level-tools.js";

/**
 * The game tools for one chat, and the lines for its system prompt.
 *
 * @param p - The chat's dependencies and id; whether Unity came up in this chat; the Unreal project in use (shared,
 *   the Unreal tools set it); whether an Unreal engine is installed; the jobs store; a function that refreshes the
 *   chat's tools (after a project is opened); the chat model (for graph changes in words); the current turn (its id and
 *   message, for one checkpoint per turn); and what to do when a turn's first checkpoint is made (the chat's ↺ line).
 * @returns The tools and the notes, in the order they always had.
 */
export function gameTools(p: { deps: ConversationDeps; id?: string; unityInChat: boolean; unreal: { project?: string }; unrealEngines: boolean; jobs: () => JobStore; refresh: () => void; chatModel: () => string | undefined; turn?: () => { id: string; label: string } | undefined; onCheckpoint?: (checkpointId: string) => void }): { tools: AgentTool[]; notes: string[] } {
  const { deps, id } = p;
  const tools: AgentTool[] = [];
  const notes: string[] = [];
  // The phones the user builds for (Settings → For developers → Target phones).
  const phones = () => chosenPhones(deps.config.phones?.targets ?? [], (deps.config.phones?.custom ?? []) as Phone[]);
  // Unity through its CLI: when it is installed here, or a Unity project was added (then unity_status explains a missing CLI).
  const unity = deps.unity && (deps.unity.cliKnown() || deps.unity.activeProject)
    ? unityTools(deps.unity, join(deps.outputsDir, id ?? "unity"), async (data, mimeType) => (await deps.assets.save(data, mimeType, { meta: { use: "unity-screenshot" } })).id, phones, async (assetId) => {
        const got = await deps.assets.get(assetId);
        return got && got.asset.mimeType.startsWith("image/") ? { data: got.data, mimeType: got.asset.mimeType } : undefined;
      }, id ? unityTurns(deps.unity).handle(id) : undefined)
    : [];
  // Fewer tokens: the long Unity guide and every Unity tool only while a Unity project is in use.
  if (unity.length && p.unityInChat) notes.push(UNITY_NOTE);
  else if (unity.length && deps.unity?.activeProject) notes.push(`The user's Unity project is ${basename(deps.unity.activeProject)}. For Unity work, load its tools with find_tools (unity_status first); their guide comes with them.`);
  else if (unity.length) notes.push("Unity's CLI is installed here: for Unity work, ask the user to pick or create a Unity project (+ → Project, or the Unity page); unity_status shows what is ready.");
  // Graphs in words from any chat: Unity Script/State Graphs, and Unreal Blueprints (KesherAI Bridge plugin).
  if (unity.length && deps.unity?.activeProject) {
    tools.push(...graphTools("unity", deps.unity, deps.registry, p.chatModel));
    notes.push("unity_list_graphs, unity_read_graph and unity_change_graph see and change the project's Visual Scripting graphs (Script Graphs and State Graphs) in words; prefer them for graph logic.");
  }
  if (deps.unreal?.available) {
    tools.push(...graphTools("unreal", deps.unreal, deps.registry, p.chatModel, async (png) => (await deps.assets.save(png, "image/png", { meta: { use: "unreal-test" } })).id));
    notes.push((deps.unreal.connected ? "The user's Unreal Editor is connected (KesherAI Bridge)" : "The user's Unreal Editor is closed: graph tools start a headless editor (30-90 s a call, so batch a change into one unreal_change_graph)") + ": unreal_list_graphs, unreal_read_graph and unreal_change_graph see and change Blueprints in words (one undo step, then compiled); unreal_test_blueprint plays the game in the editor for a few seconds and returns the log and a picture, to check a change works.");
  }
  // Unreal 5.8's own MCP server (the "Unreal Engine" connection): how to use it well.
  if ((deps.mcpTools?.() ?? []).some((t) => /(^|_)(list_toolsets|describe_toolset)$/.test(t.spec.name))) {
    notes.push(
      "Unreal Editor tools (Unreal's own MCP server): first list_toolsets, then describe_toolset on the one you need to read its tools' exact arguments, then call_tool with toolset_name, tool_name and arguments — never guess tool names. Check for project skills with AgentSkillToolset.ListSkills and follow a relevant one. Ask the user to save before a change that touches several assets. Wait for compiles to finish (LiveCodingToolset.CompileLiveCoding for C++). Read every result: anything that is not an explicit success is a stop. If Play-in-Editor is running, asset tools behave differently: stop it first or tell the user.",
    );
  }
  // Godot: its tools when its editor is connected or Godot is installed here.
  if (deps.godot && (deps.godot.status().connected || deps.godot.installed)) {
    const g = godotTools(deps.godot, async (png) => (await deps.assets.save(png, "image/png", { meta: { use: "godot-screenshot" } })).id);
    // All of them either way: the editor may connect during the chat (godot_connect opens it), and the tools are
    // fixed for a chat; the short note is enough until it is connected.
    tools.push(...g);
    notes.push(deps.godot.status().connected ? GODOT_NOTE : `${GODOT_IDLE_NOTE} Once connected: ${GODOT_NOTE}`);
  }
  // UEFN (Fortnite) and Verse: when UEFN has made its projects folder here.
  if (existsSync(join(homedir(), "Documents", "Fortnite Projects"))) {
    tools.push(...uefnTools());
    notes.push(VERSE_NOTE);
  }
  // Search the user's game projects with the engine closed (classes, scripts, scenes, prefabs, Blueprints, assets).
  tools.push(gameFindTool(
    () => findGameProjects({ unity: deps.config.unity.projects, ...(deps.unreal?.projectFile ? { unrealFile: deps.unreal.projectFile } : {}) }),
    () => deps.unity?.activeProject ?? (p.unreal.project && deps.unreal?.projectFile ? dirname(deps.unreal.projectFile) : p.unreal.project),
  ));
  // Minecraft and Roblox projects (two small tools, one line).
  tools.push(...modTools(join(deps.outputsDir, "..", "engines")));
  notes.push(MOD_NOTE);
  tools.push(...(deps.unity?.activeProject ? unity : unity.filter((t) => t.spec.name === "unity_status")));
  // Fewer tokens: with no Unreal project in use, only the three entry tools and one line go to the model
  // (the full set and its long guide come once a project is created or opened); every message carried ~1,500
  // tokens of Unreal guidance before, also in chats that had nothing to do with Unreal.
  if (p.unreal.project) {
    tools.push(...unrealTools(p.unreal, join(deps.outputsDir, "..", "logs"), p.jobs(), p.refresh, phones));
    notes.push(UNREAL_NOTE);
  } else if (p.unrealEngines) {
    tools.push(...unrealTools(p.unreal, join(deps.outputsDir, "..", "logs"), p.jobs(), p.refresh, phones).filter((t) => /^unreal_(status|create_project|use_project)$/.test(t.spec.name)));
    notes.push("Unreal Engine is installed here: for Unreal work start with unreal_status, then unreal_create_project or unreal_use_project (the other Unreal tools and their guide come after that).");
  }
  // Unreal levels: their actors, and a material on an actor's mesh (live through the Bridge, or with Unreal closed).
  if (p.unreal.project || deps.unreal?.connected) {
    tools.push(...unrealLevelTools({
      ...(deps.unreal ? { bridge: deps.unreal } : {}),
      projectDir: () => (deps.unreal?.projectFile ? dirname(deps.unreal.projectFile) : p.unreal.project ? (/\.uproject$/i.test(p.unreal.project) ? dirname(p.unreal.project) : p.unreal.project) : undefined),
    }));
    notes.push("unreal_inspect_level lists a level's actors (labels, classes, transforms, mesh slots and materials), also with Unreal closed; unreal_apply_material puts a material in an actor's mesh slot (the user sees the old → new material before it runs).");
  }
  // A game project in use: running its Android build on the user's phone and reading why it closed.
  if (p.unreal.project || deps.unity?.activeProject) {
    tools.push(...androidPhoneTools());
    notes.push(BUILD_RESEARCH_NOTE);
    // The phones the user builds for (Settings → For developers → Target phones): one short line.
    const chosen = phones();
    if (chosen.length) notes.push(phoneNote(chosen));
  }
  const dirs = (): ProjectDirs => {
    const godotFile = deps.godot?.status().editor?.projectFile;
    return {
      ...(deps.unity?.activeProject ? { unity: deps.unity.activeProject } : {}),
      ...(deps.unreal?.projectFile ? { unreal: dirname(deps.unreal.projectFile) } : {}),
      ...(godotFile ? { godot: dirname(godotFile) } : {}),
    };
  };
  const store = deps.gameCheckpoints;
  return { tools: store && id ? withCheckpoints(tools, { store, chatId: id, dirs, turn: p.turn ?? (() => undefined), ...(p.onCheckpoint ? { onCreated: p.onCheckpoint } : {}) }) : tools, notes };
}

/** The folders of the projects a chat's engine tools work on. */
export interface ProjectDirs {
  unity?: string;
  unreal?: string;
  godot?: string;
}

/** A Godot res:// path (or a plain relative one) as a path in the project. */
const resPath = (dir: string, v: unknown) => (typeof v === "string" && v.trim() ? join(dir, v.trim().replace(/^res:\/\//, "")) : undefined);

/**
 * The project files an engine chat tool is about to write (step 5 of the engine-closed gap list): only tools that name
 * their file. Changes held in the editor's memory (unity_modify_scene, godot_edit) are kept when they are saved with a
 * named scene.
 *
 * @param name - The tool.
 * @param input - Its input.
 * @param dirs - The projects in use.
 * @returns The engine, project folder and files, or undefined for a tool that writes no named file.
 */
export function engineWrites(name: string, input: Record<string, unknown>, dirs: ProjectDirs): { engine: GameEngine; project: string; files: string[] } | undefined {
  const path = typeof input.path === "string" ? input.path : "";
  const one = (engine: GameEngine, project: string | undefined, file: string | undefined) => (project && file ? { engine, project, files: [file] } : undefined);
  switch (name) {
    case "unity_write_script":
      return one("unity", dirs.unity, path && dirs.unity ? join(dirs.unity, path) : undefined);
    case "unity_scene":
      return input.action === "save" && path ? one("unity", dirs.unity, dirs.unity ? join(dirs.unity, path) : undefined) : undefined;
    case "unity_change_graph":
      return one("unity", dirs.unity, dirs.unity ? unityAssetFile(dirs.unity, path) : undefined);
    case "unreal_change_graph":
      return one("unreal", dirs.unreal, dirs.unreal ? unrealAssetFile(dirs.unreal, path) : undefined);
    case "unreal_apply_material":
      return one("unreal", dirs.unreal, dirs.unreal && typeof input.level === "string" ? unrealLevelFile(dirs.unreal, input.level.trim()) : undefined);
    case "unreal_write_source":
      return one("unreal", dirs.unreal, path && dirs.unreal ? join(dirs.unreal, path) : undefined);
    case "godot_file":
      return input.action === "write" ? one("godot", dirs.godot, dirs.godot ? resPath(dirs.godot, input.file) : undefined) : undefined;
    case "godot_scene":
      return input.action === "new" || input.action === "save" ? one("godot", dirs.godot, dirs.godot ? resPath(dirs.godot, input.scene) : undefined) : undefined;
    default:
      return undefined;
  }
}

/**
 * Wraps the engine tools that write project files: before each run, the files are kept in the chat turn's checkpoint
 * (one per turn; binaries too). A checkpoint that fails never stops the tool.
 *
 * @param tools - The chat's game tools.
 * @param o - The store, the chat, the projects in use, the current turn, and a callback for a turn's first checkpoint.
 * @returns The tools, the writing ones wrapped.
 */
export function withCheckpoints(tools: AgentTool[], o: { store: GameCheckpoints; chatId: string; dirs: () => ProjectDirs; turn: () => { id: string; label: string } | undefined; onCreated?: (checkpointId: string) => void }): AgentTool[] {
  return tools.map((t) => {
    if (t.risk === "read") return t;
    return {
      ...t,
      run: async (input, ctx) => {
        const w = engineWrites(t.spec.name, input, o.dirs());
        if (w) {
          const turn = o.turn() ?? { id: `call-${Date.now()}`, label: t.spec.name };
          const got = await o.store.capture({ engine: w.engine, project: w.project, name: basename(w.project), source: "chat", label: turn.label, group: `chat:${o.chatId}:${turn.id}`, chatId: o.chatId }, w.files).catch(() => undefined);
          if (got?.created) o.onCreated?.(got.checkpoint.id);
        }
        return t.run(input, ctx);
      },
    };
  });
}
