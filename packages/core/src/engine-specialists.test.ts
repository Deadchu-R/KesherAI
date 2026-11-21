import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentTool, ModelTurn } from "@kesher/agent";
import { delegateTool, engineAgents, type HelperApproval } from "./delegate.js";
import { specialistAgents, specialistInstructions, specialistReady, specialistTools } from "./engine-specialists.js";
import { HelperRuns } from "./helper-runs.js";

const tool = (name: string, risk: AgentTool["risk"], run?: AgentTool["run"]): AgentTool => ({
  risk,
  spec: { name, description: name, inputSchema: { type: "object", properties: {} } },
  run: run ?? (async () => ({ output: "ok" })),
});

/** A chat with every engine tool, plus tools no specialist may get. */
const chat = (): AgentTool[] => [
  ...["read_file", "search", "list_files", "game_find", "unity_status", "unity_inspect_object", "unity_screenshot", "unreal_inspect_level", "godot_tree", "web_search"].map((n) => tool(n, "read")),
  ...["unity_blockout", "unreal_blockout", "unity_vfx", "unreal_vfx", "unity_create_pbr_material", "unity_texture_settings", "unreal_apply_material", "unity_modify_scene", "unity_create_gameobject", "unity_scene", "godot_edit", "godot_scene", "write_file", "unity_write_script", "unreal_python"].map((n) => tool(n, "write")),
  tool("make_pbr_texture", "exec"),
  tool("run_command", "exec"),
  tool("delegate", "safe"),
];

const names = (t: AgentTool[]) => t.map((x) => x.spec.name);

test("each specialist gets the read tools and only its own engine tools", () => {
  const level = names(specialistTools("level", chat()));
  const vfx = names(specialistTools("vfx", chat()));
  const mat = names(specialistTools("materials", chat()));
  for (const list of [level, vfx, mat]) {
    assert.ok(list.includes("read_file") && list.includes("unity_screenshot") && list.includes("unreal_inspect_level"));
    // Never: the web, files outside the engine, scripts, commands, Python, more helpers.
    for (const no of ["web_search", "write_file", "unity_write_script", "unreal_python", "run_command", "delegate"]) assert.ok(!list.includes(no), `${no} leaked`);
  }
  assert.ok(level.includes("unity_blockout") && level.includes("unreal_blockout") && level.includes("unity_modify_scene") && !level.includes("unity_vfx") && !level.includes("make_pbr_texture"));
  assert.ok(vfx.includes("unity_vfx") && vfx.includes("unreal_vfx") && !vfx.includes("unity_blockout") && !vfx.includes("unity_create_pbr_material"));
  assert.ok(mat.includes("make_pbr_texture") && mat.includes("unity_create_pbr_material") && mat.includes("unity_texture_settings") && mat.includes("unreal_apply_material") && !mat.includes("unity_blockout"));
  // Risks are kept, so changes ask the user.
  assert.equal(specialistTools("level", chat()).find((t) => t.spec.name === "unity_blockout")!.risk, "write");
});

test("Unreal's MCP server tools come only when it is connected", () => {
  const withMcp = [...chat(), tool("unreal_list_toolsets", "read"), tool("unreal_call_tool", "exec")];
  assert.ok(names(specialistTools("vfx", withMcp)).includes("unreal_call_tool"));
  assert.ok(!names(specialistTools("vfx", [...chat(), tool("other_call_tool", "exec")])).includes("other_call_tool"));
  assert.match(specialistInstructions("vfx", true), /Niagara toolset/);
  assert.doesNotMatch(specialistInstructions("vfx", false), /call_tool/);
});

test("specialists are offered only where their engine tools are", () => {
  assert.equal(specialistReady("level", chat()), true);
  const noEngine = [tool("read_file", "read")];
  assert.deepEqual(engineAgents({ tools: () => noEngine }), []);
  assert.deepEqual(engineAgents({ tools: () => [tool("make_pbr_texture", "exec")] }).map((a) => a.name), ["materials"]);
  const all = specialistAgents({ operate: 12 });
  assert.deepEqual(all.map((a) => [a.name, a.kind, a.specialist, a.maxTurns]), [["materials", "operate", "materials", 12], ["vfx", "operate", "vfx", 12], ["level", "operate", "level", 12]]);
  // The instructions end with the role's checklist.
  assert.match(all[2]!.instructions, /- \[ \] navmesh: /);
});

test("the lead delegates to the Level design specialist: approved engine steps, checklist on its card", async () => {
  const asked: HelperApproval[] = [];
  const placed: unknown[] = [];
  const seen: { system: string; tools: string[] }[] = [];
  const tools = chat().map((t) => (t.spec.name === "unity_blockout" ? { ...t, run: async (input: Record<string, unknown>) => (placed.push(input), { output: "Placed 4 objects and 1 lights under Blockout" }) } : t));
  const model: ModelTurn = async (req) => {
    const last = req.messages.at(-1);
    if (last?.role === "user") {
      seen.push({ system: String(req.messages[0]?.content ?? ""), tools: req.tools.map((t) => t.name) });
      return { text: "", toolCalls: [{ id: "1", name: "unity_blockout", arguments: { items: [{ shape: "floor", cell: [0, 0], span: [4, 4] }] } }] };
    }
    return { text: "Made a room under Blockout.\n- [x] layout: 4x4 room\n- [x] blockout: floor and walls\n- [x] lighting: sun\n- [ ] navmesh: AI Navigation not installed\n- [ ] checkpoint", toolCalls: [] };
  };
  const runs = new HelperRuns({ limit: () => 2 });
  const d = delegateTool({
    tools: () => tools,
    currentModel: () => "m",
    turnFor: () => model,
    models: () => ["m"],
    runs,
    chatId: "c1",
    approve: async (req: HelperApproval) => (asked.push(req), { decision: "allow" as const }),
  });
  const r = await d.run({ parts: [{ task: "Block out a small arena", title: "Arena block-out", agent: "level" }] }, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.equal(placed.length, 1, "the engine tool ran after the approval");
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.name, "unity_blockout");
  assert.equal(asked[0]!.helper.agent, "level", "the card names the specialist");
  assert.match(seen[0]!.system, /Level design specialist/);
  assert.ok(seen[0]!.tools.includes("unity_blockout") && !seen[0]!.tools.includes("web_search") && !seen[0]!.tools.includes("unity_vfx"));
  assert.match(r.output, /agent level/);
  const id = /\(id (h-\w+)\)/.exec(r.output)![1]!;
  const info = runs.get(id)!;
  assert.equal(info.specialist, "level");
  assert.deepEqual(info.checklist!.map((m) => [m.key, m.done]), [["layout", true], ["blockout", true], ["lighting", true], ["navmesh", false], ["checkpoint", false]]);
});

test("a denied engine step does not run", async () => {
  let ran = 0;
  const tools = chat().map((t) => (t.spec.name === "unity_vfx" ? { ...t, run: async () => ((ran++), { output: "made" }) } : t));
  const model: ModelTurn = async (req) => (req.messages.at(-1)?.role === "user" ? { text: "", toolCalls: [{ id: "1", name: "unity_vfx", arguments: { action: "create", preset: "fire" } }] } : { text: "stopped", toolCalls: [] });
  const d = delegateTool({ tools: () => tools, currentModel: () => "m", turnFor: () => model, models: () => ["m"], approve: async () => ({ decision: "deny" as const }) });
  await d.run({ parts: [{ task: "a campfire", agent: "vfx" }] }, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.equal(ran, 0);
});
