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
        "Make widgets with add, then describe each one with ONE style operation (plain words; KesherAI turns them into Unreal settings):",
        '{"op":"add","class":"CanvasPanel","name":"Root"}   (only when the tree is empty: the root)',
        '{"op":"add","class":"TextBlock","parent":"Root","name":"TitleText"}',
        '{"op":"add","class":"Button","parent":"Root","name":"StartButton"}   {"op":"add","class":"TextBlock","parent":"StartButton","name":"StartLabel"}',
        '{"op":"style","widget":"TitleText","text":"MY GAME","fontSize":96,"color":"orange","place":"top","size":[900,140],"offset":[0,120],"align":"center"}',
        '{"op":"style","widget":"StartButton","background":"blue","place":"center","size":[400,100]}',
        '{"op":"style","widget":"StartLabel","text":"START","fontSize":48,"color":"white"}',
        "style fields (all optional): text, fontSize, color, background (a name like red, blue, orange, white, black, green, yellow, purple, gray, or #RRGGBB), place (top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right, fill), size [width,height], offset [x,y] (pixels from that place), align (left|center|right for text), padding (number), visible (true|false).",
        "Widget classes: TextBlock, Image, Button, Border, CanvasPanel, HorizontalBox, VerticalBox, Overlay, SizeBox, ProgressBar, Spacer. A Button or Border takes ONE child.",
        '{"op":"remove","widget":"<name>"}   {"op":"move","widget":"<name>","parent":"<panel>","index":0}',
        "The design is 1920×1080. Use the names already in the tree for widgets that exist. Only change what was asked.",
      ].join("\n"),
    },
    { role: "user", content: `The widget tree now:\n${widgetOutline(root)}${selected ? `\n\nThe user has selected: ${selected}` : ""}\n\nChange: ${request}` },
  ];
}

const NAMED: Record<string, [number, number, number]> = {
  red: [1, 0.1, 0.1], orange: [1, 0.55, 0.1], yellow: [1, 0.9, 0.1], green: [0.15, 0.8, 0.25], blue: [0.15, 0.4, 1], cyan: [0.1, 0.85, 0.95], purple: [0.6, 0.25, 0.95], pink: [1, 0.4, 0.7],
  white: [1, 1, 1], black: [0, 0, 0], gray: [0.5, 0.5, 0.5], grey: [0.5, 0.5, 0.5], "dark gray": [0.15, 0.15, 0.17], gold: [1, 0.8, 0.2], brown: [0.5, 0.3, 0.15],
};
/** A colour name or #RRGGBB (screen colours) → UMG's linear colour, or undefined. */
export function linearColor(v: unknown): string | undefined {
  const s = String(v ?? "").trim().toLowerCase();
  let rgb = NAMED[s];
  const hex = /^#?([0-9a-f]{6})$/.exec(s)?.[1];
  if (hex) rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  if (!rgb) return /^\(R=/.test(String(v)) ? String(v) : undefined;
  const l = (x: number) => Math.pow(x, 2.2).toFixed(4);
  return `(R=${l(rgb[0])},G=${l(rgb[1])},B=${l(rgb[2])},A=1)`;
}
const PLACES: Record<string, [number, number]> = { "top-left": [0, 0], top: [0.5, 0], "top-center": [0.5, 0], "top-right": [1, 0], left: [0, 0.5], "center-left": [0, 0.5], center: [0.5, 0.5], middle: [0.5, 0.5], right: [1, 0.5], "center-right": [1, 0.5], "bottom-left": [0, 1], bottom: [0.5, 1], "bottom-center": [0.5, 1], "bottom-right": [1, 1] };

/** One "style" operation (plain words) → the exact set operations for that widget's class and slot. */
export function expandStyle(op: Record<string, unknown>, cls: string, inCanvas: boolean, parentCls = ""): Array<Record<string, unknown>> {
  const w = String(op.widget ?? "");
  const out: Array<Record<string, unknown>> = [];
  const set = (property: string, value: string) => out.push({ op: "set", widget: w, property, value });
  // Inside a Border or a Button the content is centred, as people expect from a button (found on the real editor:
  // START sat in the top-left corner of its blue box). "align" left/right moves it to that side.
  if (/^(Border|Button)$/.test(parentCls)) {
    const a = String(op.align ?? "center").toLowerCase();
    set("slot.HorizontalAlignment", a === "left" ? "HAlign_Left" : a === "right" ? "HAlign_Right" : "HAlign_Center");
    set("slot.VerticalAlignment", "VAlign_Center");
  }
  if (op.text !== undefined && /Text/.test(cls)) set("Text", String(op.text));
  if (op.fontSize !== undefined && /Text/.test(cls)) set("fontSize", String(Math.round(Number(op.fontSize)) || 24));
  const color = linearColor(op.color);
  if (color) set(/Text/.test(cls) ? "ColorAndOpacity" : /Image/.test(cls) ? "ColorAndOpacity" : /Border/.test(cls) ? "BrushColor" : /Button/.test(cls) ? "BackgroundColor" : "ColorAndOpacity", /Text/.test(cls) ? `(SpecifiedColor=${color},ColorUseRule=UseColor_Specified)` : color);
  const bg = linearColor(op.background);
  if (bg) set(/Button/.test(cls) ? "BackgroundColor" : /Border/.test(cls) ? "BrushColor" : "ColorAndOpacity", bg);
  if (typeof op.align === "string" && /Text/.test(cls)) set("Justification", /center/i.test(op.align) ? "Center" : /right/i.test(op.align) ? "Right" : "Left");
  if (op.padding !== undefined && /Border/.test(cls)) set("Padding", `(Left=${Number(op.padding)},Top=${Number(op.padding)},Right=${Number(op.padding)},Bottom=${Number(op.padding)})`);
  if (op.visible === false) set("Visibility", "Collapsed");
  if (op.visible === true) set("Visibility", "Visible");
  if (inCanvas) {
    const place = String(op.place ?? "").toLowerCase().replace(/\s+/g, "-");
    const size = Array.isArray(op.size) ? op.size.map(Number) : undefined;
    const offset = Array.isArray(op.offset) ? op.offset.map(Number) : [0, 0];
    if (place === "fill") {
      set("slot.anchors", "0,0,1,1");
      set("slot.position", "0,0");
      set("slot.size", "0,0");
    } else if (PLACES[place]) {
      const [x, y] = PLACES[place];
      set("slot.anchors", `${x},${y},${x},${y}`);
      set("slot.alignment", `${x},${y}`);
      // Offsets go inward from the edges (a "top" widget 120 down, a "bottom-right" one up and left).
      set("slot.position", `${(x === 1 ? -1 : 1) * (offset[0] ?? 0)},${(y === 1 ? -1 : 1) * (offset[1] ?? 0)}`);
    } else if (op.offset !== undefined) set("slot.position", `${offset[0] ?? 0},${offset[1] ?? 0}`);
    if (size && size.length === 2 && size.every((n) => Number.isFinite(n) && n > 0)) set("slot.size", `${Math.round(size[0]!)},${Math.round(size[1]!)}`);
  }
  return out;
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
export function cleanWidgetOps(ops: Array<Record<string, unknown>>, classOf: (name: string) => string | undefined, parentClassOf: (name: string) => string | undefined = () => undefined): Array<Record<string, unknown>> {
  const made = new Map<string, string>();
  const madeIn = new Map<string, string>();
  const out: Array<Record<string, unknown>> = [];
  for (const op of ops) {
    if (op.op === "add" && typeof op.name === "string" && typeof op.class === "string") {
      made.set(op.name, op.class);
      if (typeof op.parent === "string") madeIn.set(op.name, op.parent);
    }
    // Plain words → the exact settings (small models get these right far more often).
    if (op.op === "style" && typeof op.widget === "string") {
      const cls = made.get(op.widget) ?? classOf(op.widget) ?? "";
      const parent = madeIn.get(op.widget);
      const parentCls = parent ? made.get(parent) ?? classOf(parent) : parentClassOf(op.widget);
      out.push(...expandStyle(op, cls, /CanvasPanel/.test(parentCls ?? ""), parentCls ?? ""));
      continue;
    }
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
  const parents = new Map<string, string>();
  const walk = (w?: WidgetNode) => {
    if (!w) return;
    classes.set(w.name, w.class);
    for (const c of w.children ?? []) {
      parents.set(c.name, w.class);
      walk(c);
    }
  };
  walk(tree.root);
  const ops = cleanWidgetOps(parsed.ops, (n) => classes.get(n), (n) => parents.get(n));
  const note = parsed.note;
  if (!ops.length) return { ops, note: note || "Nothing to change.", applied: false };
  const result = await b.request<{ results: Array<{ ok: boolean; error?: string; widget?: string }>; failed: number }>("widget_apply", { path: opts.path, ops }, 30_000);
  const compile = await b.request<{ ok: boolean; messages: Array<{ severity: string; text: string }> }>("compile", { path: opts.path }).catch(() => undefined);
  return { ops, note, applied: true, result, ...(compile ? { compile } : {}) };
}
