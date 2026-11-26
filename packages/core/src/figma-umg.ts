/**
 * A Figma frame → Unreal widgets (UMG), as the KesherAI Bridge's widget
 * operations.
 *
 * How others do it (researched first): figma2umg (Figma REST API with a
 * personal token, frames → UserWidget hierarchy, text and basic shapes;
 * box layouts still on its roadmap) and Figma2Unreal. KesherAI goes one step
 * further on layout: a frame with Figma auto layout becomes a Horizontal or
 * Vertical Box (gap → slot padding, padding → a Border's padding), other
 * frames a Canvas Panel with each child at its place; text becomes a Text
 * Block (words, size, colour, alignment), filled shapes Images in their
 * colour, a frame's fill a Border (or a stretched Image under a canvas).
 * Pictures inside the design come in as grey placeholders, named, to be
 * replaced by imported textures.
 */

/** The parts of Figma's node JSON used here. */
export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  characters?: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  fills?: Array<{ type: string; visible?: boolean; color?: { r: number; g: number; b: number; a: number }; opacity?: number }>;
  style?: { fontSize?: number; textAlignHorizontal?: string };
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL";
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  opacity?: number;
  children?: FigmaNode[];
}

type Op = Record<string, string | number>;

/** Figma colours are sRGB 0–1; UMG's FLinearColor is linear. */
const linear = (c: { r: number; g: number; b: number; a: number }, opacity = 1) => {
  const l = (x: number) => Math.pow(Math.min(1, Math.max(0, x)), 2.2).toFixed(4);
  return `(R=${l(c.r)},G=${l(c.g)},B=${l(c.b)},A=${(c.a * opacity).toFixed(3)})`;
};
const solid = (n: FigmaNode) => n.fills?.find((f) => f.type === "SOLID" && f.visible !== false && f.color);
const hasImage = (n: FigmaNode) => !!n.fills?.some((f) => f.type === "IMAGE" && f.visible !== false);
const CONTAINER = /^(FRAME|GROUP|COMPONENT|COMPONENT_SET|INSTANCE|SECTION)$/;
const SHAPE = /^(RECTANGLE|ELLIPSE|VECTOR|STAR|POLYGON|LINE|BOOLEAN_OPERATION)$/;

/**
 * @param frame - The Figma node (a frame) to bring in.
 * @param parent - The panel in the Widget Blueprint it goes into (empty: it becomes the root).
 * @param taken - Names already in the Widget Blueprint.
 * @param max - At most this many widgets.
 * @param parentIsCanvas - The panel it goes into is a Canvas Panel (the frame is then given its size there).
 * @returns The operations, and what could not come over as it is.
 */
export function figmaToWidgetOps(frame: FigmaNode, parent: string, taken: Iterable<string> = [], max = 300, parentIsCanvas = false): { ops: Op[]; notes: string[] } {
  const ops: Op[] = [];
  const notes: string[] = [];
  const used = new Set(taken);
  const nameFor = (n: FigmaNode, fallback: string) => {
    const base = (n.name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || fallback).replace(/^(\d)/, "_$1").slice(0, 48);
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    return name;
  };
  const add = (cls: string, n: FigmaNode, into: string, fallback: string) => {
    const name = nameFor(n, fallback);
    ops.push({ op: "add", class: cls, ...(into ? { parent: into } : {}), name });
    return name;
  };
  const set = (widget: string, property: string, value: string | number) => ops.push({ op: "set", widget, property, value: String(value) });
  const box = (n: FigmaNode) => n.absoluteBoundingBox ?? { x: 0, y: 0, width: 100, height: 100 };

  /** Puts a widget at the child's place when its panel is a canvas. */
  const place = (widget: string, n: FigmaNode, origin: { x: number; y: number } | undefined) => {
    if (!origin) return;
    const b = box(n);
    set(widget, "slot.position", `${Math.round(b.x - origin.x)},${Math.round(b.y - origin.y)}`);
    set(widget, "slot.size", `${Math.round(b.width)},${Math.round(b.height)}`);
  };
  /** In a box: the gap after each child (Figma's item spacing) as slot padding. */
  const gap = (widget: string, layout: string | undefined, spacing: number, last: boolean) => {
    if (!layout || !spacing || last) return;
    set(widget, "slot.Padding", layout === "HORIZONTAL" ? `(Left=0,Top=0,Right=${spacing},Bottom=0)` : `(Left=0,Top=0,Right=0,Bottom=${spacing})`);
  };

  const visit = (n: FigmaNode, into: string, origin: { x: number; y: number } | undefined, layout: string | undefined, spacing: number, last: boolean) => {
    if (n.visible === false || ops.length >= max * 3) return;
    if (n.type === "TEXT") {
      const w = add("TextBlock", n, into, "Text");
      set(w, "Text", (n.characters ?? "").slice(0, 2000));
      if (n.style?.fontSize) set(w, "fontSize", Math.round(n.style.fontSize));
      const c = solid(n);
      if (c?.color) set(w, "ColorAndOpacity", `(SpecifiedColor=${linear(c.color, c.opacity ?? 1)},ColorUseRule=UseColor_Specified)`);
      const j = n.style?.textAlignHorizontal;
      if (j === "CENTER" || j === "RIGHT") set(w, "Justification", j === "CENTER" ? "Center" : "Right");
      place(w, n, origin);
      gap(w, layout, spacing, last);
      return;
    }
    if (SHAPE.test(n.type) || (CONTAINER.test(n.type) && !n.children?.length)) {
      const w = add("Image", n, into, "Shape");
      const c = solid(n);
      if (hasImage(n)) {
        set(w, "ColorAndOpacity", "(R=0.2,G=0.2,B=0.2,A=1)");
        notes.push(`${w}: a picture in Figma — import it as a texture and set it on this Image.`);
      } else if (c?.color) set(w, "ColorAndOpacity", linear(c.color, c.opacity ?? 1));
      else if (n.type !== "RECTANGLE") notes.push(`${w}: a ${n.type.toLowerCase()} without a plain colour, shown as a white box.`);
      place(w, n, origin);
      gap(w, layout, spacing, last);
      return;
    }
    if (!CONTAINER.test(n.type)) {
      notes.push(`${n.name}: ${n.type} is not brought over.`);
      return;
    }
    // A container: a Border for its fill and padding when it has them, then the panel for its children.
    const b = box(n);
    const fill = solid(n);
    const auto = n.layoutMode === "HORIZONTAL" || n.layoutMode === "VERTICAL" ? n.layoutMode : undefined;
    const pad = auto && (n.paddingLeft || n.paddingTop || n.paddingRight || n.paddingBottom) ? `(Left=${n.paddingLeft ?? 0},Top=${n.paddingTop ?? 0},Right=${n.paddingRight ?? 0},Bottom=${n.paddingBottom ?? 0})` : "";
    let outer = "";
    let panelInto = into;
    if ((fill?.color || pad) && into) {
      outer = add("Border", { ...n, name: `${n.name}_Bg` }, into, "Background");
      if (fill?.color) set(outer, "BrushColor", linear(fill.color, fill.opacity ?? 1));
      else set(outer, "BrushColor", "(R=0,G=0,B=0,A=0)");
      if (pad) set(outer, "Padding", pad);
      place(outer, n, origin);
      gap(outer, layout, spacing, last);
      panelInto = outer;
    }
    const panel = add(auto === "HORIZONTAL" ? "HorizontalBox" : auto === "VERTICAL" ? "VerticalBox" : "CanvasPanel", n, panelInto, "Panel");
    if (!outer) {
      place(panel, n, origin);
      gap(panel, layout, spacing, last);
    }
    // The root of an empty Widget Blueprint with a fill: a stretched Image behind the children.
    if (!into && fill?.color && !auto) {
      const bg = add("Image", { ...n, name: `${n.name}_Background` }, panel, "Background");
      set(bg, "ColorAndOpacity", linear(fill.color, fill.opacity ?? 1));
      set(bg, "slot.anchors", "0,0,1,1");
      set(bg, "slot.position", "0,0");
      set(bg, "slot.size", "0,0");
    }
    const kids = (n.children ?? []).filter((k) => k.visible !== false);
    kids.forEach((k, i) => visit(k, panel, auto ? undefined : { x: b.x, y: b.y }, auto, n.itemSpacing ?? 0, i === kids.length - 1));
  };

  visit(frame, parent, undefined, undefined, 0, true);
  // In a canvas, the frame keeps its size (top left of the canvas).
  const first = ops.find((o) => o.op === "add");
  if (first && parent && parentIsCanvas) {
    const b = box(frame);
    ops.splice(ops.indexOf(first) + 1, 0, { op: "set", widget: String(first.name), property: "slot.size", value: `${Math.round(b.width)},${Math.round(b.height)}` });
  }
  if (ops.filter((o) => o.op === "add").length >= max) notes.push(`Only the first ${max} widgets came over; pick a smaller frame for the rest.`);
  return { ops, notes };
}
