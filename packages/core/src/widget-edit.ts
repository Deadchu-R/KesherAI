import type { ProviderRegistry } from "@kesher/providers";
import { modelTurnFor } from "./conversations.js";
import { parseOps, type UnrealBridge } from "./unreal-bridge.js";

/**
 * Widget Blueprints (UMG) in words: the widget tree goes to a model as an
 * indented outline, it answers with operations (add / set / remove / move),
 * and the KesherAI Bridge applies them in the editor as one undo step.
 *
 * How others do it (researched first): Unreal's UMG Designer edits the same
 * tree (panels with slots: Canvas Panel positions, Horizontal/Vertical Box
 * padding and fill); figma2umg turns Figma frames into that tree; AI widget
 * tools write the tree as data and apply it with UMG's editor API.
 */

/** One widget as the plugin sends it. */
export interface WidgetNode {
  name: string;
  class: string;
  props?: Record<string, string | number>;
  slot?: Record<string, string | number | boolean>;
  children?: WidgetNode[];
}

/** The tree as a short outline: one widget per line, its slot and the properties that matter. */
export function widgetOutline(root: WidgetNode | undefined): string {
  if (!root) return "(empty: no root widget yet)";
  const lines: string[] = [];
  const walk = (w: WidgetNode, depth: number) => {
    const s = w.slot ?? {};
    const where = "x" in s ? ` @(${s.x},${s.y}) size(${s.w},${s.h})${s.autoSize ? " auto" : ""}` : s.Padding ? ` padding${s.Padding}` : "";
    const props = Object.entries(w.props ?? {})
      .filter(([k, v]) => v !== "" && !(k === "Visibility" && v === "Visible") && !(k === "RenderOpacity" && Number(v) === 1) && !(k === "bIsEnabled" && v === "True"))
      .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
      .join(" ");
    lines.push(`${"  ".repeat(depth)}${w.name}: ${w.class}${where}${props ? ` {${props}}` : ""}`);
    for (const c of w.children ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  return lines.join("\n");
}

/** The messages for the model: what the operations are and the tree as it is. */
export function widgetPrompt(root: WidgetNode | undefined, request: string, selected?: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "You change an Unreal Engine Widget Blueprint (UMG). Answer with ONE JSON object and nothing else:",
        '{"ops":[...],"note":"one short sentence saying what changed"}',
        "Operations:",
        '- {"op":"add","class":"TextBlock|Image|Button|Border|CanvasPanel|HorizontalBox|VerticalBox|Overlay|SizeBox|ScrollBox|ProgressBar|Spacer","parent":"<panel name>","name":"<new name>"}  (the first widget of an empty tree has no parent and becomes the root; a Button or Border takes ONE child)',
        '- {"op":"set","widget":"<name>","property":"Text|fontSize|ColorAndOpacity|BrushColor|BackgroundColor|Padding|Visibility|Justification|Percent|WidthOverride|HeightOverride","value":"<value>"}',
        '- {"op":"set","widget":"<name>","property":"slot.position|slot.size|slot.anchors|slot.alignment|slot.autoSize","value":"x,y | w,h | minX,minY,maxX,maxY | x,y | true"}  (in a Canvas Panel)',
        '- {"op":"set","widget":"<name>","property":"slot.Padding|slot.HorizontalAlignment|slot.VerticalAlignment|slot.Size","value":"..."}  (in a box or overlay; e.g. Padding (Left=8,Top=8,Right=8,Bottom=8), HorizontalAlignment HAlign_Center, Size (SizeRule=Fill,Value=1.0))',
        '- {"op":"remove","widget":"<name>"}   {"op":"move","widget":"<name>","parent":"<panel>","index":0}',
        "Values as Unreal writes them: colors (R=1,G=0.5,B=0,A=1) with 0–1 numbers; Visibility Visible|Collapsed|Hidden; Justification Left|Center|Right.",
        "Positions are pixels in a 1920×1080 design. Keep names unique and readable (TitleText, StartButton). Only change what was asked.",
      ].join("\n"),
    },
    { role: "user", content: `The widget tree now:\n${widgetOutline(root)}${selected ? `\n\nThe user has selected: ${selected}` : ""}\n\nChange: ${request}` },
  ];
}

/**
 * Changes a Widget Blueprint as asked: the model writes the operations, the
 * editor applies them (one undo step) and compiles.
 */
export async function editWidget(b: UnrealBridge, registry: ProviderRegistry, modelId: string, opts: { path: string; request: string; selected?: string; signal: AbortSignal }) {
  const tree = await b.request<{ root?: WidgetNode }>("widget", { path: opts.path }, 30_000);
  const turn = modelTurnFor(registry, modelId);
  const text = (await turn({ messages: widgetPrompt(tree.root, opts.request, opts.selected), tools: [] }, AbortSignal.any([opts.signal, AbortSignal.timeout(300_000)]), () => undefined)).text;
  const { ops, note } = parseOps(text);
  if (!ops.length) return { ops, note: note || "Nothing to change.", applied: false };
  const result = await b.request<{ results: Array<{ ok: boolean; error?: string; widget?: string }>; failed: number }>("widget_apply", { path: opts.path, ops }, 30_000);
  const compile = await b.request<{ ok: boolean; messages: Array<{ severity: string; text: string }> }>("compile", { path: opts.path }).catch(() => undefined);
  return { ops, note, applied: true, result, ...(compile ? { compile } : {}) };
}
