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
        "Widget classes: TextBlock, Image, Button, Border, CanvasPanel, HorizontalBox, VerticalBox, Overlay, SizeBox, ScrollBox, ProgressBar, Spacer. The first widget of an empty tree has no parent and becomes the root; a Button or Border takes ONE child.",
        "One property per set operation, exactly as in these examples:",
        '{"op":"add","class":"CanvasPanel","name":"Root"}',
        '{"op":"add","class":"TextBlock","parent":"Root","name":"TitleText"}',
        '{"op":"set","widget":"TitleText","property":"Text","value":"MY GAME"}',
        '{"op":"set","widget":"TitleText","property":"fontSize","value":"72"}',
        '{"op":"set","widget":"TitleText","property":"ColorAndOpacity","value":"(SpecifiedColor=(R=1,G=0.4,B=0,A=1),ColorUseRule=UseColor_Specified)"}',
        '{"op":"set","widget":"TitleText","property":"Justification","value":"Center"}',
        '{"op":"set","widget":"TitleText","property":"slot.anchors","value":"0.5,0,0.5,0"}   (minX,minY,maxX,maxY; 0.5 = middle)',
        '{"op":"set","widget":"TitleText","property":"slot.alignment","value":"0.5,0"}   (which point of the widget sits on the anchor)',
        '{"op":"set","widget":"TitleText","property":"slot.position","value":"0,120"}   (pixels from the anchor)',
        '{"op":"set","widget":"TitleText","property":"slot.size","value":"900,120"}',
        '{"op":"add","class":"Button","parent":"Root","name":"StartButton"}   {"op":"set","widget":"StartButton","property":"BackgroundColor","value":"(R=0.1,G=0.3,B=1,A=1)"}',
        '{"op":"add","class":"TextBlock","parent":"StartButton","name":"StartLabel"}',
        '{"op":"set","widget":"SomeBorder","property":"BrushColor","value":"(R=0,G=0,B=0,A=0.6)"}   {"op":"set","widget":"SomeBorder","property":"Padding","value":"(Left=16,Top=8,Right=16,Bottom=8)"}',
        'In a box or overlay: {"op":"set","widget":"X","property":"slot.Padding","value":"(Left=0,Top=0,Right=0,Bottom=12)"}  slot.HorizontalAlignment HAlign_Center  slot.Size (SizeRule=Fill,Value=1.0)',
        '{"op":"remove","widget":"<name>"}   {"op":"move","widget":"<name>","parent":"<panel>","index":0}',
        "Values as Unreal writes them: colors (R=1,G=0.5,B=0,A=1) with 0–1 numbers; Visibility Visible|Collapsed|Hidden; Justification Left|Center|Right.",
        "Positions are pixels in a 1920×1080 design. Keep names unique and readable (TitleText, StartButton). Only change what was asked.",
      ].join("\n"),
    },
    { role: "user", content: `The widget tree now:\n${widgetOutline(root)}${selected ? `\n\nThe user has selected: ${selected}` : ""}\n\nChange: ${request}` },
  ];
}

/** Canvas slot fields a model may write without "slot.". */
const SLOT_FIELDS: Record<string, string> = { position: "position", pos: "position", size: "size", anchors: "anchors", anchor: "anchors", alignment: "alignment", autosize: "autoSize", zorder: "z", z: "z" };

/**
 * What small models write wrongly, made right before it reaches the editor
 * (found on the real editor: "position|slot.size|…" copied from the
 * instructions, "position" without "slot.", a Border's "BackgroundColor"):
 * one property per operation, slot fields under "slot.", the property each
 * widget really has. Operations that cannot be made right are left out.
 *
 * @param ops - The model's operations.
 * @param classOf - The class of a widget by its name (those made in the same answer included).
 */
export function cleanWidgetOps(ops: Array<Record<string, unknown>>, classOf: (name: string) => string | undefined): Array<Record<string, unknown>> {
  const made = new Map<string, string>();
  const out: Array<Record<string, unknown>> = [];
  for (const op of ops) {
    if (op.op === "add" && typeof op.name === "string" && typeof op.class === "string") made.set(op.name, op.class);
    if (op.op !== "set" || typeof op.property !== "string") {
      out.push(op);
      continue;
    }
    // "a|b|c": the model copied a list of choices; nothing tells which it meant.
    if (op.property.includes("|")) continue;
    let prop = op.property.trim();
    const bare = prop.replace(/^slot\./i, "");
    const field = SLOT_FIELDS[bare.toLowerCase()];
    if (field) prop = `slot.${field}`;
    else if (/^fontsize$/i.test(prop)) prop = "fontSize";
    const cls = made.get(String(op.widget)) ?? classOf(String(op.widget)) ?? "";
    if (/Border/.test(cls) && /^(BackgroundColor|Color|ColorAndOpacity)$/.test(prop)) prop = "BrushColor";
    if (/TextBlock/.test(cls) && /^(Color|TextColor)$/.test(prop)) prop = "ColorAndOpacity";
    if (/TextBlock/.test(cls) && prop === "ColorAndOpacity" && /^\(R=/.test(String(op.value))) op.value = `(SpecifiedColor=${String(op.value)},ColorUseRule=UseColor_Specified)`;
    if (/Image/.test(cls) && /^(Color|BrushColor)$/.test(prop)) prop = "ColorAndOpacity";
    out.push({ ...op, property: prop });
  }
  return out;
}

/**
 * Changes a Widget Blueprint as asked: the model writes the operations, the
 * editor applies them (one undo step) and compiles.
 */
export async function editWidget(b: UnrealBridge, registry: ProviderRegistry, modelId: string, opts: { path: string; request: string; selected?: string; signal: AbortSignal }) {
  const tree = await b.request<{ root?: WidgetNode }>("widget", { path: opts.path }, 30_000);
  const turn = modelTurnFor(registry, modelId);
  const text = (await turn({ messages: widgetPrompt(tree.root, opts.request, opts.selected), tools: [] }, AbortSignal.any([opts.signal, AbortSignal.timeout(300_000)]), () => undefined)).text;
  const parsed = parseOps(text);
  const classes = new Map<string, string>();
  const walk = (w?: WidgetNode) => {
    if (!w) return;
    classes.set(w.name, w.class);
    (w.children ?? []).forEach(walk);
  };
  walk(tree.root);
  const ops = cleanWidgetOps(parsed.ops, (n) => classes.get(n));
  const note = parsed.note;
  if (!ops.length) return { ops, note: note || "Nothing to change.", applied: false };
  const result = await b.request<{ results: Array<{ ok: boolean; error?: string; widget?: string }>; failed: number }>("widget_apply", { path: opts.path, ops }, 30_000);
  const compile = await b.request<{ ok: boolean; messages: Array<{ severity: string; text: string }> }>("compile", { path: opts.path }).catch(() => undefined);
  return { ops, note, applied: true, result, ...(compile ? { compile } : {}) };
}
