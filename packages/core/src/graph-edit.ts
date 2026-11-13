import type { ProviderRegistry } from "@kesher/providers";
import type { AgentTool } from "@kesher/agent";
import { modelTurnFor } from "./model-turn.js";
import { blueprintPrompt, parseOps, unityPrompt, type UnrealBridge } from "./unreal-bridge.js";
import { blueprintToCode, codeText, type CodeNode } from "@kesher/shared";
import type { UnityCli } from "./unity-cli.js";
import { describeRun, runBlueprintTest } from "./blueprint-test.js";

type Bridge = UnrealBridge | UnityCli;

/** What changing a graph in words came back with. */
export interface GraphEdit {
  ops: unknown[];
  note: string;
  applied: boolean;
  queued?: string;
  result?: { results: Array<{ ok: boolean; error?: string }>; failed: number };
  compile?: { ok: boolean; messages: Array<{ severity: string; text: string }> };
}

/**
 * Changes an Unreal Blueprint or a Unity Script/State Graph as asked in
 * words: a model writes the operations (checked by parseOps), the bridge
 * applies them in the editor as one undo step and compiles. Unreal with the
 * editor closed: the change waits in the queue and applies when it opens.
 * Shared by the Unreal/Unity pages and the chat's graph tools.
 */
export async function editGraph(
  kind: "unreal" | "unity",
  b: Bridge,
  registry: ProviderRegistry,
  modelId: string,
  opts: { path: string; graph?: string; request: string; signal: AbortSignal },
): Promise<GraphEdit> {
  const { graph: g } = await b.graph(opts.path);
  const graphName = opts.graph || g.graphs[0]?.name || "EventGraph";
  const turn = modelTurnFor(registry, modelId);
  const text = (await turn({ messages: kind === "unreal" ? blueprintPrompt(g, graphName, opts.request) : unityPrompt(g, opts.request), tools: [] }, AbortSignal.any([opts.signal, AbortSignal.timeout(300_000)]), () => undefined)).text;
  const { ops, note } = parseOps(text);
  if (!ops.length) return { ops, note: note || "Nothing to change.", applied: false };
  if (kind === "unreal" && !b.connected) {
    const project = (await b.project()) ?? "Project";
    const queued = await (b as UnrealBridge).enqueue({ project, path: opts.path, graph: graphName, ops, request: opts.request });
    return { ops, note, applied: false, queued: queued.id };
  }
  const result = await b.request<{ results: Array<{ ok: boolean; error?: string }>; failed: number }>("apply", { path: opts.path, graph: graphName, ops: kind === "unity" ? JSON.stringify(ops) : ops }, kind === "unity" ? 120_000 : 30_000);
  const compile = await b.request<{ ok: boolean; messages: Array<{ severity: string; text: string }> }>("compile", { path: opts.path }).catch(() => undefined);
  return { ops, note, applied: true, result, ...(compile ? { compile } : {}) };
}

/**
 * Chat tools for the graphs: list them, read one, and change one in words
 * (Unreal Blueprints through the KesherAI Bridge plugin; Unity Script and
 * State Graphs through Unity's CLI and the KesherAI Bridge package).
 */
export function graphTools(kind: "unreal" | "unity", b: Bridge, registry: ProviderRegistry, modelId: () => string | undefined, saveImage?: (png: Buffer) => Promise<string>): AgentTool[] {
  const what = kind === "unreal" ? "Unreal Blueprint" : "Unity Script Graph or State Graph";
  const pre = kind === "unreal" ? "unreal" : "unity";
  const tools: AgentTool[] = [
    {
      risk: "read",
      spec: {
        name: `${pre}_list_graphs`,
        description: `List the ${what}s in the user's ${kind === "unreal" ? "Unreal" : "Unity"} project (path, name, parent).`,
        inputSchema: { type: "object", properties: { filter: { type: "string", description: "Part of a name, to narrow the list." } } },
      },
      run: async (input) => {
        const r = await b.list();
        const f = String(input.filter ?? "").toLowerCase();
        const rows = r.blueprints.filter((x) => !f || x.name.toLowerCase().includes(f)).slice(0, 200);
        return { output: `${r.project ? `Project ${r.project}` : "No project"}${r.offline ? " (editor closed: saved copies)" : ""}\n${rows.map((x) => `${x.path}${x.parent ? ` (${x.parent})` : ""}`).join("\n") || "None."}` };
      },
    },
    {
      risk: "read",
      spec: {
        name: `${pre}_read_graph`,
        description: `Read one ${what} as code: each event a block, its nodes in the order they run, wired values as arguments (much shorter than a node list).`,
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      run: async (input) => {
        const { graph: g, offline } = await b.graph(String(input.path ?? ""));
        // The graph as code (the page's Code view): fewer tokens than every node, pin and link, and easier to follow.
        const lines = g.graphs.map((gr) => `## ${gr.name}${gr.kind ? ` (${gr.kind})` : ""}\n${codeText(blueprintToCode(gr.nodes as CodeNode[]))}`);
        const vars = g.variables?.length ? `Variables: ${g.variables.map((v) => `${v.name}: ${v.type}`).join(", ")}\n` : "";
        const out = `${vars}${lines.join("\n")}${offline ? "\n(saved copy: the editor is closed)" : ""}`;
        return { output: out.length > 9000 ? `${out.slice(0, 9000)}\n… (cut)` : out };
      },
    },
    {
      risk: "write",
      spec: {
        name: `${pre}_change_graph`,
        description: `Change one ${what} as the user asked, in words (e.g. "on BeginPlay print Hello, and if Open is true call OpenDoor"). It is applied in the open editor as one undo step and compiled${kind === "unreal" ? "; with Unreal closed it waits and applies when the project opens" : ""}. Report the note and any compile errors.`,
        inputSchema: { type: "object", properties: { path: { type: "string" }, graph: { type: "string", description: "Which graph inside it (default: the first)." }, request: { type: "string" } }, required: ["path", "request"] },
      },
      preview: async (input) => `Change ${String(input.path ?? "")}${input.graph ? ` · ${String(input.graph)}` : ""}:\n${String(input.request ?? "")}`,
      run: async (input, ctx) => {
        const model = modelId();
        if (!model) return { output: "No chat model is chosen to write the change." };
        const r = await editGraph(kind, b, registry, model, { path: String(input.path ?? ""), ...(input.graph ? { graph: String(input.graph) } : {}), request: String(input.request ?? "").slice(0, 2000), signal: ctx.signal });
        if (!r.applied) return { output: r.queued ? `Saved the change to apply when the project opens in Unreal (${r.ops.length} operations). ${r.note}` : r.note };
        const failed = r.result?.failed ?? 0;
        const errors = (r.compile?.messages ?? []).filter((m) => /error/i.test(m.severity)).map((m) => m.text);
        return { output: `${r.note}\nApplied ${r.ops.length - failed}/${r.ops.length} operations.${failed ? ` Failed: ${(r.result?.results ?? []).filter((x) => !x.ok).map((x) => x.error).join("; ")}` : ""}${r.compile ? (r.compile.ok ? " Compiled with no errors." : ` Compile errors: ${errors.join("; ") || "see the editor"}`) : ""}` };
      },
    },
  ];
  if (kind === "unreal") {
    tools.push({
      risk: "write",
      spec: {
        name: "unreal_test_blueprint",
        description:
          "Test a Blueprint by running the game in the open Unreal Editor (Play In Editor) for a few seconds: it is compiled, an Actor Blueprint is placed in front of the player (in the play world only; the level is not changed), then you get what the game wrote (Print String, warnings, Blueprint errors such as Accessed None) and a picture of the game view. Use it after changing a Blueprint to check it works, and fix what it shows. Overlap/input events run only when triggered, so their silence is not a failure.",
        inputSchema: { type: "object", properties: { path: { type: "string", description: "The Blueprint's path (empty: just play the level)." }, seconds: { type: "number", description: "How long to play, 1–30 (default 6)." }, place: { type: "boolean", description: "Place an Actor Blueprint in front of the player (default true)." } } },
      },
      preview: async (input) => `Play the game in Unreal for ${Number(input.seconds ?? 6)} s to test ${String(input.path ?? "the level")}`,
      run: async (input, ctx) => {
        const path = String(input.path ?? "");
        const run = await runBlueprintTest(b as UnrealBridge, path, { seconds: Math.min(30, Number(input.seconds ?? 6)), place: input.place !== false, signal: ctx.signal });
        const id = run.picture && saveImage ? await saveImage(run.picture) : undefined;
        return { output: describeRun(run, path).slice(0, 8000), ...(id ? { assetIds: [id] } : {}), ...(run.picture ? { images: [{ mimeType: "image/png", data: run.picture.toString("base64") }] } : {}) };
      },
    });
  }
  return tools;
}
