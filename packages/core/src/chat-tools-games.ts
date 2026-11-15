/**
 * The game-engine tools a chat gets (docs/ARCHITECTURE_REVIEW.md C2): Unity through its CLI, Unreal (its own tools,
 * and its Blueprints in words through the KesherAI Bridge), the Visual Scripting graphs, and running a game's Android
 * build on the user's phone. Few tokens until a project is in use: then the full set and its guide come.
 */
import { basename, join } from "node:path";
import type { AgentTool } from "@kesher/agent";
import { androidPhoneTools } from "./android-phone.js";
import type { ConversationDeps } from "./conversation-deps.js";
import { graphTools } from "./graph-edit.js";
import type { JobStore } from "./jobs.js";
import { BUILD_RESEARCH_NOTE } from "./known-issues.js";
import { chosenPhones, phoneNote, type Phone } from "./phones.js";
import { UNITY_NOTE, unityTools } from "./unity-tools.js";
import { UNREAL_NOTE, unrealTools } from "./unreal-tools.js";

/**
 * The game tools for one chat, and the lines for its system prompt.
 *
 * @param p - The chat's dependencies and id; whether Unity came up in this chat; the Unreal project in use (shared,
 *   the Unreal tools set it); whether an Unreal engine is installed; the jobs store; a function that refreshes the
 *   chat's tools (after a project is opened); and the chat model (for graph changes in words).
 * @returns The tools and the notes, in the order they always had.
 */
export function gameTools(p: { deps: ConversationDeps; id?: string; unityInChat: boolean; unreal: { project?: string }; unrealEngines: boolean; jobs: () => JobStore; refresh: () => void; chatModel: () => string | undefined }): { tools: AgentTool[]; notes: string[] } {
  const { deps, id } = p;
  const tools: AgentTool[] = [];
  const notes: string[] = [];
  // The phones the user builds for (Settings → For developers → Target phones).
  const phones = () => chosenPhones(deps.config.phones?.targets ?? [], (deps.config.phones?.custom ?? []) as Phone[]);
  // Unity through its CLI: when it is installed here, or a Unity project was added (then unity_status explains a missing CLI).
  const unity = deps.unity && (deps.unity.cliKnown() || deps.unity.activeProject)
    ? unityTools(deps.unity, join(deps.outputsDir, id ?? "unity"), async (data, mimeType) => (await deps.assets.save(data, mimeType, { meta: { use: "unity-screenshot" } })).id, phones)
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
  // A game project in use: running its Android build on the user's phone and reading why it closed.
  if (p.unreal.project || deps.unity?.activeProject) {
    tools.push(...androidPhoneTools());
    notes.push(BUILD_RESEARCH_NOTE);
    // The phones the user builds for (Settings → For developers → Target phones): one short line.
    const chosen = phones();
    if (chosen.length) notes.push(phoneNote(chosen));
  }
  return { tools, notes };
}
