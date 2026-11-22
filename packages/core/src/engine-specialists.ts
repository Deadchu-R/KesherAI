import type { AgentTool } from "@kesher/agent";
import { checklistTemplate, SPECIALIST_IDS, SPECIALISTS, type SpecialistId } from "@kesher/shared";
import { HELPER_STEPS, type AgentDef } from "./agents.js";

/**
 * Engine specialists (WORK_LIST "Specialised engine agents: materials, Niagara and VFX, level design";
 * docs/RESEARCH_LOG.md, "Specialised engine agents"): three sub-agent roles the lead chat hands game-engine work to
 * with `delegate` (agent "materials", "vfx" or "level"), and that the user can pick in "who does it".
 *
 * How others do it (researched first): Unity AI's Assistant has ask / plan / agent modes and asks before each change,
 * every change undoable; Unreal 5.8's own MCP server and community servers (ue-mcp) group editor tools by area
 * (materials, Niagara, level actors and lights, navigation), so an agent loads only the toolset it needs; Ludus and
 * Coplay ship one general agent. KesherAI: one role per area, each with
 * - its own instructions (plan first, look, change in small approved steps, check with a picture),
 * - a curated tool set: the engine tools of its area plus the read tools, nothing else (no web, no other chats),
 * - an output checklist (engine-specialists.ts in shared) that the plan card shows as ✓ / ○.
 * Every tool that changes the engine keeps its own risk, so the helper's session asks the user on the chat's card
 * (naming the specialist, with the scene diff the tool's preview builds); files the engine tools write go into the
 * chat's checkpoint (chat-tools-games.ts `withCheckpoints`), because the specialist gets the chat's own wrapped tools.
 */

/** Read tools every specialist gets: files, pictures, the game index and each engine's read tools. */
const READS =
  /^(list_files|read_file|search|view_image|game_find|unity_(status|console|inspect_object|screenshot|performance)|unreal_(status|inspect_level)|level_(describe|check)|godot_(status|tree|get|screenshot|log))$/;

/** Unreal's own MCP server (5.8+), any prefix: listing toolsets is a read; `call_tool` keeps the server's risk. */
const UNREAL_MCP_READ = /(^|_)(list_toolsets|describe_toolset)$/;
const UNREAL_MCP_CALL = /(^|_)call_tool$/;

/** The engine tools that change something, per role (the tool keeps its risk: each call waits for approval). */
export const SPECIALIST_TOOLS: Readonly<Record<SpecialistId, RegExp>> = {
  materials: /^(make_pbr_texture|unity_create_pbr_material|unity_texture_settings|unity_scene|unreal_apply_material|godot_edit)$/,
  vfx: /^(unity_vfx|unreal_vfx|unity_modify_scene|unity_scene|godot_edit)$/,
  level: /^(level_arrange|level_move|unity_blockout|unreal_blockout|unity_create_gameobject|unity_modify_scene|unity_scene|godot_edit|godot_scene)$/,
};

/** Each role's Unreal MCP toolsets (named in its instructions; `describe_toolset` gives their exact tools). */
const UNREAL_TOOLSETS: Record<SpecialistId, string> = {
  materials: "the material toolset (materials, material instances and their parameters, texture assets)",
  vfx: "the Niagara toolset (systems, emitters, modules, renderers, user parameters)",
  level: "the level and navigation toolsets (actors, lights, volumes, the navmesh)",
};

/** When the lead should hand a role work (its `delegate` description). */
const WHEN: Record<SpecialistId, string> = {
  materials: "PBR textures and materials, material instances, texture import settings, applying a material to the selection or named objects",
  vfx: "particle effects from a description (Unity Particle System or VFX Graph, Unreal Niagara): create, place, tune; queued when the editor is closed",
  level: "level block-outs from a description (shapes or prefabs on a grid), a lighting pass and the navmesh",
};

/** What each role does, step by step (its system prompt's middle part). */
const STEPS: Record<SpecialistId, string> = {
  materials: [
    "You are the Materials specialist for a game project (Unity, Unreal or Godot).",
    "Steps: 1) Find what exists: the selected or named objects (unity_inspect_object / unreal_inspect_level / godot_get) and textures already in the project (game_find). 2) Make the maps when none fit: make_pbr_texture (a seamless albedo plus normal, roughness and AO). 3) Import settings: normal maps as Normal map type and not sRGB; roughness, metallic and AO linear (sRGB off); albedo sRGB; max size 2048 for phones unless asked (unity_texture_settings). 4) Make the material: unity_create_pbr_material (its render pipeline is found by itself; apply_to \"selection\" puts it on the selected objects), in Unreal prefer a material instance of an existing master material, in Godot a StandardMaterial3D through godot_edit. 5) Apply it to the chosen objects (unreal_apply_material for an actor's slot). 6) Look at it with a screenshot.",
    "Reuse one master material with instances instead of many materials; name assets M_ / MI_ / T_ with a clear suffix (_D, _N, _R, _AO).",
  ].join("\n"),
  vfx: [
    "You are the VFX specialist for a game project: Unity's Particle System (or VFX Graph) and Unreal's Niagara.",
    "Steps: 1) Turn the description into a spec: a preset (fire, smoke, sparks, magic, rain, dust, explosion, trail) and the numbers that differ (rate, lifetime, speed, size, colors, gravity, looping, duration, max particles). 2) Make it: unity_vfx or unreal_vfx (action create). With the editor closed they write the spec into the project and queue it; say so. 3) Place it at a position or attach it to an object. 4) Look at it (screenshot), then tune with action tune (only the numbers that change). 5) Keep it inside a phone budget: about 500 live particles per effect and few overlapping transparent layers; say if the user's request needs more.",
    "Unity: use the Particle System unless the project already uses VFX Graph; then write the spec and say which graph to start from.",
  ].join("\n"),
  level: [
    "You are the Level design specialist for a game project: block-outs from a description, a lighting pass and the navmesh.",
    "Steps: 1) Plan on a grid first (cell size in meters, rooms, corridors, heights, the player's start) and write the plan as a short list. 2) Place it with unity_blockout or unreal_blockout in one call (floors, walls, ramps, cover; prefabs or Blueprints the project has, by path; one parent named Blockout). Keep cells aligned; walls 3 m high and 0.2 m thick unless asked. 3) Lighting pass: one directional light (sun) and a few point or spot lights for focus areas, in the same tool's lights list. 4) Navmesh: navmesh true (a NavMeshSurface in Unity when AI Navigation is installed, a NavMeshBoundsVolume in Unreal). 5) Look at it with a screenshot and fix what is off with unity_modify_scene or another blockout call.",
    "Each placement shows the user the objects it adds before it runs, and the level is kept in a checkpoint (↺ in the chat). Save the scene only when the user's task says so (unity_scene save).",
  ].join("\n"),
};

/** The rules every role shares (after its steps). */
const COMMON = [
  "Work in small steps: look before you change, one approved change at a time. Every change waits for the user's approval on a card that names you and lists what it adds or changes; if the user denies a step, do not try it another way.",
  "Never invent asset paths, object names or tool arguments: read them first. If the engine is not connected and a tool cannot queue, say what the user should open.",
  "Finish with a short report (under 15 lines): what you made (exact asset paths and object names), what is left. Then end with this checklist, one line each, [x] for done and [ ] for not done, with a few words after each:",
].join("\n");

/**
 * The system prompt of one specialist.
 *
 * @param id - The role.
 * @param unrealMcp - Unreal's own MCP server is connected (its toolsets are named).
 * @returns The instructions.
 */
export function specialistInstructions(id: SpecialistId, unrealMcp = false): string {
  return [
    STEPS[id],
    unrealMcp ? `For Unreal work beyond these tools, use Unreal's own MCP server: list_toolsets, then describe_toolset on ${UNREAL_TOOLSETS[id]}, then call_tool with the exact names it gives.` : "",
    COMMON,
    checklistTemplate(id),
  ].filter(Boolean).join("\n\n");
}

/**
 * The tools of one specialist: the read tools and its own engine tools, from the chat's tools (already wrapped with
 * the chat's checkpoints). Each keeps its risk, so changes ask the user.
 *
 * @param id - The role.
 * @param tools - The chat's tools now.
 * @returns Its tools (no tool twice), or an empty list when the chat has none of its engine tools.
 */
export function specialistTools(id: SpecialistId, tools: AgentTool[]): AgentTool[] {
  const own = SPECIALIST_TOOLS[id];
  const mcp = tools.some((t) => UNREAL_MCP_READ.test(t.spec.name));
  return tools.filter((t) => READS.test(t.spec.name) || own.test(t.spec.name) || (mcp && (UNREAL_MCP_READ.test(t.spec.name) || UNREAL_MCP_CALL.test(t.spec.name))));
}

/**
 * Whether a specialist can work in this chat: it has at least one of the role's engine tools (a Unity, Unreal or
 * Godot project in use, or the PBR flow for materials).
 *
 * @param id - The role.
 * @param tools - The chat's tools now.
 */
export function specialistReady(id: SpecialistId, tools: AgentTool[]): boolean {
  return tools.some((t) => SPECIALIST_TOOLS[id].test(t.spec.name));
}

/**
 * The three specialists as named agents for `delegate` (source "builtin", type "operate": they act in the user's
 * engine with approval, like the operator).
 *
 * @param steps - Steps per type from Settings (the operator's cap is used; default 25).
 * @param unrealMcp - Unreal's own MCP server is connected.
 * @returns One agent per role.
 */
export function specialistAgents(steps: { operate?: number } = {}, unrealMcp = false): AgentDef[] {
  return SPECIALIST_IDS.map((id) => ({
    name: id,
    kind: "operate" as const,
    source: "builtin" as const,
    specialist: id,
    tier: "strong" as const,
    maxTurns: steps.operate ?? HELPER_STEPS.operate,
    description: `${SPECIALISTS[id].en} engine specialist: ${WHEN[id]}. Changes the open Unity, Unreal or Godot project with the user's approval per step (scene diff, checkpoint), and reports with a checklist.`,
    instructions: specialistInstructions(id, unrealMcp),
  }));
}
