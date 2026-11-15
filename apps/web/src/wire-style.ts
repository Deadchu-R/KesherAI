import type { GraphWires, WireStyle } from "@kesher/shared";

/**
 * How the graph editors draw a wire between two pins, like the Electronic Nodes plugin for Unreal (and UltraWire):
 * - "curve": the engines' own bezier;
 * - "manhattan": right angles, a straight run out of the pin, the vertical part in the middle;
 * - "subway": straight runs joined by a 45° diagonal.
 * Corners are rounded by a radius. A wire whose end is behind its start (to the left) goes around: out to the right,
 * across in the middle, and into the end from its left, as Electronic Nodes does.
 */

/** A point in graph units. */
export interface Pt {
  x: number;
  y: number;
}

/** The settings with their defaults. */
export interface WireLook {
  style: WireStyle;
  exec: WireStyle;
  radius: number;
  ribbon: boolean;
  bubbles: boolean;
}

/**
 * The saved settings with defaults filled in (curves, as before, until the user picks another style).
 *
 * @param w - The look's `wires`.
 * @returns Every setting.
 */
export function wireLook(w: GraphWires | undefined): WireLook {
  const style = w?.style ?? "curve";
  return { style, exec: w?.exec ?? style, radius: w?.radius ?? 10, ribbon: w?.ribbon ?? true, bubbles: w?.bubbles ?? true };
}

/** How far a wire runs straight out of (and into) a pin before it turns. */
export const LEAD = 22;

/**
 * The corners of a right-angle wire.
 *
 * @param a - The output pin.
 * @param z - The input pin.
 * @param offset - Moves the vertical part sideways (ribbon), in graph units.
 * @returns The polyline's points.
 */
export function manhattanPoints(a: Pt, z: Pt, offset = 0): Pt[] {
  if (Math.abs(a.y - z.y) < 0.5 && z.x >= a.x) return [a, z];
  if (z.x - a.x >= 2 * LEAD) {
    const mid = Math.min(z.x - LEAD, Math.max(a.x + LEAD, (a.x + z.x) / 2 + offset));
    return [a, { x: mid, y: a.y }, { x: mid, y: z.y }, z];
  }
  // Behind: out to the right, across between the two pins' heights, then into the input from its left.
  const midY = Math.abs(a.y - z.y) > 2 * LEAD ? (a.y + z.y) / 2 + offset : Math.max(a.y, z.y) + 60 + offset;
  const out = a.x + LEAD;
  const into = z.x - LEAD;
  return [a, { x: out, y: a.y }, { x: out, y: midY }, { x: into, y: midY }, { x: into, y: z.y }, z];
}

/**
 * The corners of a 45° wire: straight out, a diagonal over the height difference, straight in. When there is not
 * room for the diagonal, it goes around like a right-angle wire.
 *
 * @param a - The output pin.
 * @param z - The input pin.
 * @param offset - Moves the diagonal sideways (ribbon).
 * @returns The polyline's points.
 */
export function subwayPoints(a: Pt, z: Pt, offset = 0): Pt[] {
  const dy = z.y - a.y;
  const room = z.x - a.x - 2 * LEAD;
  if (Math.abs(dy) < 0.5 && z.x >= a.x) return [a, z];
  if (room < Math.abs(dy)) return manhattanPoints(a, z, offset);
  const start = Math.min(z.x - LEAD - Math.abs(dy), Math.max(a.x + LEAD, (a.x + z.x) / 2 - Math.abs(dy) / 2 + offset));
  return [a, { x: start, y: a.y }, { x: start + Math.abs(dy), y: z.y }, z];
}

const fmt = (n: number) => Math.round(n * 10) / 10;

/**
 * A polyline as an SVG path with rounded corners: each corner becomes a quadratic curve that starts and ends at most
 * `radius` from it (less when the segments are short), so the wire never overshoots.
 *
 * @param pts - The corners, start to end.
 * @param radius - The corner radius (0: sharp).
 * @returns The path's `d`.
 */
export function roundedPath(pts: Pt[], radius: number): string {
  const p = pts.filter((q, i) => i === 0 || Math.hypot(q.x - pts[i - 1]!.x, q.y - pts[i - 1]!.y) > 0.01);
  if (p.length < 2) return `M${fmt(pts[0]!.x)},${fmt(pts[0]!.y)}`;
  let d = `M${fmt(p[0]!.x)},${fmt(p[0]!.y)}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [prev, at, next] = [p[i - 1]!, p[i]!, p[i + 1]!];
    const l1 = Math.hypot(at.x - prev.x, at.y - prev.y);
    const l2 = Math.hypot(next.x - at.x, next.y - at.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.5) {
      d += ` L${fmt(at.x)},${fmt(at.y)}`;
      continue;
    }
    const inPt = { x: at.x - ((at.x - prev.x) / l1) * r, y: at.y - ((at.y - prev.y) / l1) * r };
    const outPt = { x: at.x + ((next.x - at.x) / l2) * r, y: at.y + ((next.y - at.y) / l2) * r };
    d += ` L${fmt(inPt.x)},${fmt(inPt.y)} Q${fmt(at.x)},${fmt(at.y)} ${fmt(outPt.x)},${fmt(outPt.y)}`;
  }
  const last = p[p.length - 1]!;
  return `${d} L${fmt(last.x)},${fmt(last.y)}`;
}

/**
 * A wire's path in the chosen style.
 *
 * @param a - The output pin.
 * @param z - The input pin.
 * @param style - The style.
 * @param radius - Corner radius (right angles and 45°).
 * @param offset - Ribbon offset for the middle part.
 * @returns The path's `d`.
 */
export function wirePath(a: Pt, z: Pt, style: WireStyle, radius: number, offset = 0): string {
  if (style === "manhattan") return roundedPath(manhattanPoints(a, z, offset), radius);
  if (style === "subway") return roundedPath(subwayPoints(a, z, offset), radius);
  const dx = Math.max(40, Math.abs(z.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${z.x - dx},${z.y} ${z.x},${z.y}`;
}

/**
 * Ribbon: the middle part of each wire leaving a node moves sideways by its pin's place among that node's wired
 * outputs, so wires from different pins run side by side instead of on top of each other; wires from the same pin
 * stay together (Electronic Nodes 3.x: "ribbons do not split when coming from the same pin").
 *
 * @param index - The pin's place among the node's outputs that have wires.
 * @param count - How many of the node's outputs have wires.
 * @param step - The space between two wires, in graph units.
 * @returns The offset.
 */
export function ribbonOffset(index: number, count: number, step = 7): number {
  return count < 2 ? 0 : (index - (count - 1) / 2) * step;
}
