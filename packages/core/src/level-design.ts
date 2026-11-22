/**
 * The maths of the level-design agent (WORK_LIST "Specialised engine agents": level design): where N copies of an
 * object go along a line, on a grid, on a circle or scattered; which objects overlap, stand outside the bounds or
 * float; a compact text map of a level. Pure (no engine, no files), engine-neutral: meters, x right, y up, z forward
 * (Unity's own axes; Unreal's centimeters and X-forward are converted by level-design-tools.ts).
 *
 * Sizes are estimates (a mesh is 1 m times its scale unless the engine said more), and a pivot is taken to be the
 * object's middle; the texts say so where it matters.
 */

/** A point or size in meters: x right, y up, z forward. */
export type Vec3 = [number, number, number];
/** A rectangle on the ground plane (x, z). */
export interface Box {
  min: [number, number];
  max: [number, number];
}

/** One object of a level, engine-neutral. */
export interface LevelObject {
  id: string;
  name: string;
  /** "Cube", "StaticMeshActor", "Light"…: what the counts group by. */
  type: string;
  pos: Vec3;
  /** Estimated size (right, up, forward), before yaw. */
  size: Vec3;
  /** Turn about the up axis, degrees. */
  yaw: number;
  /** A floor, terrain or road: things stand on it, and it overlaps them on purpose. */
  ground?: boolean;
  /** Draws or collides (a placed thing); false for cameras, lights, empties and volumes. */
  solid: boolean;
  /** Can be moved here (a top-level object that is not UI or part of a placed prefab). */
  movable: boolean;
  /** The parent's id, when it has one (a parent and its child never "overlap"). */
  parent?: string;
}

/** How copies are laid out. */
export const PATTERNS = ["line", "grid", "circle", "scatter"] as const;
/** One of {@link PATTERNS}. */
export type Pattern = (typeof PATTERNS)[number];

/** Where one copy goes. */
export interface Placement {
  pos: Vec3;
  /** Degrees about the up axis. */
  yaw: number;
  /** A multiplier of the object's own scale (1 = unchanged). */
  scale: number;
}

/** What {@link arrangePoints} needs. */
export interface ArrangeOptions {
  pattern: Pattern;
  /** 1 to {@link MAX_COPIES}. */
  count: number;
  /** One copy's footprint (right, forward) in meters: the default spacing and the room it needs. */
  size: [number, number];
  /** Every copy stays inside (its footprint, not only its middle). */
  bounds?: Box;
  /** Middle of a grid or circle; default the bounds' middle, else the origin. */
  center?: [number, number];
  /** A line from here to there (x, z). Without them: along x, through `center`. */
  from?: [number, number];
  to?: [number, number];
  /** Grid columns; default the square root of the count, rounded up. */
  columns?: number;
  /** Gap between middles in meters; default 1.25 × the footprint. */
  spacing?: number;
  /** Circle radius in meters; default: as big as the spacing needs. */
  radius?: number;
  /** Where the first copy of a circle sits, degrees from +x toward +z. */
  startAngle?: number;
  /** The copies' turn about the up axis. */
  yaw?: number;
  /** Each copy's yaw varies by up to ± this many degrees. */
  yawJitter?: number;
  /** Each copy moves by up to ± this many meters (not for scatter, which is random already). */
  posJitter?: number;
  /** Each copy's scale varies by up to ± this fraction. */
  scaleJitter?: number;
  /** The same seed gives the same jitter and scatter, so a preview and the real run agree. */
  seed?: number;
  /** Places to keep clear (what is already there), for scatter. */
  avoid?: Box[];
  /** Height when the ground is not known. */
  y?: number;
  /** Ground height at (x, z), when known: the copies stand on it. */
  ground?: (x: number, z: number) => number | undefined;
  /** How far above the ground an object's middle rests (half its height for a middle pivot, 0 for a base pivot). */
  lift?: number;
}

/** The most copies one call places. */
export const MAX_COPIES = 500;

/** The result of {@link arrangePoints}. */
export interface Arranged {
  placements: Placement[];
  /** How many of the asked copies did not fit (outside the bounds, or no free spot found). */
  dropped: number;
  /** Plain sentences about what was adjusted (spacing tightened, radius reduced…). */
  notes: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100 || 0;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * A small seeded random generator (mulberry32): 0 ≤ value < 1, the same for the same seed.
 *
 * @param seed - Any integer.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The box an object covers on the ground, turned by its yaw.
 *
 * @param o - The object (only pos, size and yaw are used).
 */
export function footprint(o: Pick<LevelObject, "pos" | "size" | "yaw">): Box {
  const a = (o.yaw * Math.PI) / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const hx = (o.size[0] * c + o.size[2] * s) / 2;
  const hz = (o.size[0] * s + o.size[2] * c) / 2;
  return { min: [o.pos[0] - hx, o.pos[2] - hz], max: [o.pos[0] + hx, o.pos[2] + hz] };
}

const boxesOverlap = (a: Box, b: Box, gap = 0) => a.min[0] < b.max[0] + gap && b.min[0] < a.max[0] + gap && a.min[1] < b.max[1] + gap && b.min[1] < a.max[1] + gap;

/**
 * The ground height at a point from the floor-like objects: the top of the highest one whose footprint holds the point.
 *
 * @param objects - The level's objects.
 * @param skip - An object that is not part of the ground for this question (the one being placed).
 * @returns A function; undefined where no ground is under the point.
 */
export function groundHeight(objects: readonly LevelObject[], skip?: ReadonlySet<string>): (x: number, z: number) => number | undefined {
  const floors = objects.filter((o) => o.ground && !skip?.has(o.id)).map((o) => ({ box: footprint(o), top: o.pos[1] + o.size[1] / 2 }));
  return (x, z) => {
    let top: number | undefined;
    for (const f of floors) if (x >= f.box.min[0] && x <= f.box.max[0] && z >= f.box.min[1] && z <= f.box.max[1] && (top === undefined || f.top > top)) top = f.top;
    return top;
  };
}

/**
 * Where N copies go. Everything is deterministic for a seed; copies that would stand outside the bounds are dropped
 * (and counted), and a grid, line or circle that is too big for the bounds is tightened first, down to just not
 * overlapping.
 *
 * @param o - The pattern and its limits.
 * @returns The placements, how many did not fit, and notes about what was adjusted.
 */
export function arrangePoints(o: ArrangeOptions): Arranged {
  const count = clamp(Math.round(o.count) || 1, 1, MAX_COPIES);
  const notes: string[] = [];
  const rnd = seededRandom(o.seed ?? 1);
  const [w, d] = o.size;
  const spacing = o.spacing && o.spacing > 0 ? o.spacing : Math.max(w, d, 0.1) * 1.25;
  const b = o.bounds;
  const center: [number, number] = o.center ?? (b ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2] : [0, 0]);
  const inside = (x: number, z: number) => !b || (x - w / 2 >= b.min[0] - 1e-6 && x + w / 2 <= b.max[0] + 1e-6 && z - d / 2 >= b.min[1] - 1e-6 && z + d / 2 <= b.max[1] + 1e-6);
  let pts: Array<[number, number]> = [];

  if (o.pattern === "line") {
    const from = o.from ?? [center[0] - (spacing * (count - 1)) / 2, center[1]];
    const to = o.to ?? [from[0] + spacing * (count - 1), from[1]];
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const ux = len > 0 ? (to[0] - from[0]) / len : 1, uz = len > 0 ? (to[1] - from[1]) / len : 0;
    if (o.from && o.to && !(o.spacing && o.spacing > 0)) {
      // From → to with no spacing: spread evenly, ends included.
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0.5 : i / (count - 1);
        pts.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
      }
    } else {
      for (let i = 0; i < count; i++) {
        const dist = spacing * i;
        if (o.to && dist > len + 1e-6) break;
        pts.push([from[0] + ux * dist, from[1] + uz * dist]);
      }
      if (pts.length < count && o.to) notes.push(`Only ${pts.length} fit between the two ends at a spacing of ${r2(spacing)} m.`);
    }
  } else if (o.pattern === "grid") {
    const cols = clamp(Math.round(o.columns ?? Math.ceil(Math.sqrt(count))), 1, count);
    const rows = Math.ceil(count / cols);
    let sx = spacing, sz = spacing;
    if (b) {
      // Tighten the gaps to fit the bounds, never closer than touching.
      if (cols > 1 && (cols - 1) * sx + w > b.max[0] - b.min[0]) {
        sx = Math.max(w * 1.02, (b.max[0] - b.min[0] - w) / (cols - 1));
        notes.push(`The columns were tightened to ${r2(sx)} m apart to fit the bounds.`);
      }
      if (rows > 1 && (rows - 1) * sz + d > b.max[1] - b.min[1]) {
        sz = Math.max(d * 1.02, (b.max[1] - b.min[1] - d) / (rows - 1));
        notes.push(`The rows were tightened to ${r2(sz)} m apart to fit the bounds.`);
      }
    }
    for (let i = 0; i < count; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      pts.push([center[0] + (c - (cols - 1) / 2) * sx, center[1] + (r - (rows - 1) / 2) * sz]);
    }
  } else if (o.pattern === "circle") {
    let radius = o.radius && o.radius > 0 ? o.radius : Math.max((spacing * count) / (2 * Math.PI), Math.max(w, d));
    if (b) {
      const room = Math.min(b.max[0] - b.min[0] - w, b.max[1] - b.min[1] - d) / 2;
      if (room > 0 && radius > room) {
        radius = room;
        notes.push(`The radius was reduced to ${r2(radius)} m to stay inside the bounds.`);
      }
    }
    const start = ((o.startAngle ?? 0) * Math.PI) / 180;
    for (let i = 0; i < count; i++) {
      const a = start + (2 * Math.PI * i) / count;
      pts.push([center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]);
    }
  } else {
    // Scatter: random spots at least `spacing` apart, inside the bounds, clear of what is already there.
    const half = (Math.sqrt(count) * spacing * 1.5) / 2;
    const area: Box = b ? { min: [b.min[0] + w / 2, b.min[1] + d / 2], max: [b.max[0] - w / 2, b.max[1] - d / 2] } : { min: [center[0] - half, center[1] - half], max: [center[0] + half, center[1] + half] };
    if (area.max[0] >= area.min[0] && area.max[1] >= area.min[1]) {
      const near = spacing * spacing;
      let tries = 0;
      while (pts.length < count && tries < count * 60) {
        tries++;
        const x = area.min[0] + rnd() * (area.max[0] - area.min[0]);
        const z = area.min[1] + rnd() * (area.max[1] - area.min[1]);
        if (pts.some((p) => (p[0] - x) ** 2 + (p[1] - z) ** 2 < near)) continue;
        const mine: Box = { min: [x - w / 2, z - d / 2], max: [x + w / 2, z + d / 2] };
        if (o.avoid?.some((a) => boxesOverlap(mine, a))) continue;
        pts.push([x, z]);
      }
    }
    if (pts.length < count) notes.push(`Only ${pts.length} of ${count} spots were free at a spacing of ${r2(spacing)} m.`);
  }

  const jitter = o.pattern === "scatter" ? 0 : o.posJitter ?? 0;
  const placements: Placement[] = [];
  for (const [px, pz] of pts) {
    const x = px + (jitter ? (rnd() * 2 - 1) * jitter : 0);
    const z = pz + (jitter ? (rnd() * 2 - 1) * jitter : 0);
    if (!inside(x, z)) continue;
    const yaw = (o.yaw ?? 0) + (o.yawJitter ? (rnd() * 2 - 1) * o.yawJitter : 0);
    const scale = o.scaleJitter ? Math.max(0.1, 1 + (rnd() * 2 - 1) * o.scaleJitter) : 1;
    const ground = o.ground?.(x, z);
    placements.push({ pos: [r2(x), r2(ground !== undefined ? ground + (o.lift ?? 0) : o.y ?? 0), r2(z)], yaw: r2(yaw), scale: r2(scale) });
  }
  pts = [];
  const dropped = count - placements.length;
  if (dropped > 0 && !notes.length) notes.push(`${dropped} of ${count} would stand outside the bounds and were left out.`);
  return { placements, dropped, notes };
}

/** What {@link checkLevel} is asked. */
export interface CheckOptions {
  /** Everything should stand inside; default the floors' box, and with no floors no bounds check. */
  bounds?: Box;
  /** How far above the ground counts as floating, meters (default 0.3). */
  tolerance?: number;
  /** Overlaps thinner than this are touching, not overlapping (default 0.05 m). */
  minOverlap?: number;
}

/** What {@link checkLevel} found. */
export interface CheckResult {
  overlaps: Array<{ a: string; b: string; depth: number }>;
  outside: Array<{ name: string; by: number }>;
  floating: Array<{ name: string; gap: number }>;
  /** How many solid objects were looked at. */
  checked: number;
  /** The box the outside check used, when there was one. */
  bounds?: Box;
}

/**
 * Looks for overlapping objects, objects outside the bounds and objects floating above the ground. Floors overlap what
 * stands on them on purpose, so they are left out of the overlap check; a parent and its child never overlap.
 *
 * @param objects - The level's objects.
 * @param o - The bounds and the tolerances.
 * @returns What was found (the lists are not capped; the caller trims them for text).
 */
export function checkLevel(objects: readonly LevelObject[], o: CheckOptions = {}): CheckResult {
  const tol = o.tolerance ?? 0.3;
  const thin = o.minOverlap ?? 0.05;
  const things = objects.filter((x) => x.solid && !x.ground);
  const boxes = things.map((x) => ({ x, box: footprint(x) }));
  const overlaps: CheckResult["overlaps"] = [];
  // Sweep along x: sorted by the left edge, each box meets only those that start before its right edge.
  const sorted = [...boxes].sort((p, q) => p.box.min[0] - q.box.min[0]);
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const q = sorted[j]!;
      if (q.box.min[0] >= p.box.max[0] - thin) break;
      if (p.x.parent === q.x.id || q.x.parent === p.x.id) continue;
      const dx = Math.min(p.box.max[0], q.box.max[0]) - Math.max(p.box.min[0], q.box.min[0]);
      const dz = Math.min(p.box.max[1], q.box.max[1]) - Math.max(p.box.min[1], q.box.min[1]);
      const dy = Math.min(p.x.pos[1] + p.x.size[1] / 2, q.x.pos[1] + q.x.size[1] / 2) - Math.max(p.x.pos[1] - p.x.size[1] / 2, q.x.pos[1] - q.x.size[1] / 2);
      if (dx > thin && dz > thin && dy > thin) overlaps.push({ a: p.x.name, b: q.x.name, depth: r2(Math.min(dx, dz, dy)) });
    }
  }
  overlaps.sort((p, q) => q.depth - p.depth);

  let bounds = o.bounds;
  if (!bounds) {
    const floors = objects.filter((x) => x.ground).map(footprint);
    if (floors.length) bounds = { min: [Math.min(...floors.map((f) => f.min[0])), Math.min(...floors.map((f) => f.min[1]))], max: [Math.max(...floors.map((f) => f.max[0])), Math.max(...floors.map((f) => f.max[1]))] };
  }
  const outside: CheckResult["outside"] = [];
  if (bounds) {
    for (const { x, box } of boxes) {
      const by = Math.max(bounds.min[0] - box.min[0], bounds.min[1] - box.min[1], box.max[0] - bounds.max[0], box.max[1] - bounds.max[1]);
      if (by > tol) outside.push({ name: x.name, by: r2(by) });
    }
  }

  const floating: CheckResult["floating"] = [];
  for (const { x } of boxes) {
    const top = groundHeight(objects, new Set([x.id]))(x.pos[0], x.pos[2]);
    if (top === undefined) continue;
    // A middle pivot rests at half its height above the ground, a base pivot at 0: only more than that floats.
    const gap = x.pos[1] - top - x.size[1] / 2;
    if (gap > tol) floating.push({ name: x.name, gap: r2(gap) });
  }
  floating.sort((p, q) => q.gap - p.gap);
  return { overlaps, outside, floating, checked: things.length, ...(bounds ? { bounds } : {}) };
}

/** "Crate (3)", "Crate_12", "Crate.004" → "Crate": what counts group by. */
export function baseName(name: string): string {
  return name.replace(/[\s_.-]*\(?\d+\)?$/, "") || name;
}

/**
 * The biggest empty rectangle on the ground (the "free space"), on a coarse grid over the box.
 *
 * @param objects - The level's objects (solid ones that are not floors take up room).
 * @param bounds - The area to look in.
 * @param cell - Cell size in meters (default: the area's long side over 48, at least 0.5).
 * @returns The rectangle with its size, or undefined when there is no room at all.
 */
export function largestFreeRect(objects: readonly LevelObject[], bounds: Box, cell?: number): { box: Box; width: number; depth: number } | undefined {
  const W = bounds.max[0] - bounds.min[0], D = bounds.max[1] - bounds.min[1];
  if (!(W > 0 && D > 0)) return undefined;
  const c = cell ?? Math.max(0.5, Math.max(W, D) / 48);
  const cols = Math.max(1, Math.ceil(W / c)), rows = Math.max(1, Math.ceil(D / c));
  const taken = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  for (const o of objects) {
    if (!o.solid || o.ground) continue;
    const f = footprint(o);
    const c0 = clamp(Math.floor((f.min[0] - bounds.min[0]) / c), 0, cols - 1), c1 = clamp(Math.floor((f.max[0] - bounds.min[0] - 1e-9) / c), 0, cols - 1);
    const r0 = clamp(Math.floor((f.min[1] - bounds.min[1]) / c), 0, rows - 1), r1 = clamp(Math.floor((f.max[1] - bounds.min[1] - 1e-9) / c), 0, rows - 1);
    if (f.max[0] < bounds.min[0] || f.min[0] > bounds.max[0] || f.max[1] < bounds.min[1] || f.min[1] > bounds.max[1]) continue;
    for (let r = r0; r <= r1; r++) for (let k = c0; k <= c1; k++) taken[r]![k] = true;
  }
  // Largest rectangle of free cells: histogram of free run lengths per row, a stack per row.
  const height = new Array<number>(cols).fill(0);
  let best = { area: 0, c0: 0, r0: 0, w: 0, h: 0 };
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) height[k] = taken[r]![k] ? 0 : height[k]! + 1;
    const stack: number[] = [];
    for (let k = 0; k <= cols; k++) {
      const h = k === cols ? 0 : height[k]!;
      while (stack.length && height[stack[stack.length - 1]!]! >= h) {
        const top = height[stack.pop()!]!;
        const left = stack.length ? stack[stack.length - 1]! + 1 : 0;
        const width = k - left;
        if (top * width > best.area) best = { area: top * width, c0: left, r0: r - top + 1, w: width, h: top };
      }
      stack.push(k);
    }
  }
  if (!best.area) return undefined;
  const box: Box = { min: [bounds.min[0] + best.c0 * c, bounds.min[1] + best.r0 * c], max: [Math.min(bounds.max[0], bounds.min[0] + (best.c0 + best.w) * c), Math.min(bounds.max[1], bounds.min[1] + (best.r0 + best.h) * c)] };
  return { box, width: r2(box.max[0] - box.min[0]), depth: r2(box.max[1] - box.min[1]) };
}

const range = (lo: number, hi: number) => `${r2(lo)}..${r2(hi)}`;

/**
 * A compact text map of a level for the model: counts, bounds, the objects by area (a 3 × 3 split) and the free space.
 *
 * @param objects - The level's objects.
 * @param o - The title (engine and scene) and an optional name filter.
 * @returns Plain text, a few dozen lines at most.
 */
export function describeLevel(objects: readonly LevelObject[], o: { title: string; filter?: string }): string {
  const f = o.filter?.trim().toLowerCase();
  const shown = f ? objects.filter((x) => `${x.name} ${x.type}`.toLowerCase().includes(f)) : objects;
  const solid = shown.filter((x) => x.solid);
  const lines = [`${o.title}: ${shown.length} objects${f ? ` match "${f}"` : ""} (${solid.length} placed things, ${shown.length - solid.length} others such as lights, cameras and empties). Positions in meters: x right, y up, z forward; sizes are estimates (a mesh is 1 m times its scale).`];
  if (!shown.length) return lines[0]!;
  const boxes = solid.map(footprint);
  if (!boxes.length) {
    lines.push(`By type: ${countBy(shown.map((x) => x.type))}.`);
    return lines.join("\n");
  }
  const bounds: Box = { min: [Math.min(...boxes.map((b) => b.min[0])), Math.min(...boxes.map((b) => b.min[1]))], max: [Math.max(...boxes.map((b) => b.max[0])), Math.max(...boxes.map((b) => b.max[1]))] };
  const lo = Math.min(...solid.map((x) => x.pos[1] - x.size[1] / 2)), hi = Math.max(...solid.map((x) => x.pos[1] + x.size[1] / 2));
  lines.push(`Bounds: x ${range(bounds.min[0], bounds.max[0])}, z ${range(bounds.min[1], bounds.max[1])} (${r2(bounds.max[0] - bounds.min[0])} × ${r2(bounds.max[1] - bounds.min[1])} m), height ${range(lo, hi)} m.`);
  lines.push(`By type: ${countBy(shown.map((x) => x.type))}.`);
  const W = bounds.max[0] - bounds.min[0], D = bounds.max[1] - bounds.min[1];
  const cellOf = (x: LevelObject) => ({ col: clamp(Math.floor(((x.pos[0] - bounds.min[0]) / (W || 1)) * 3), 0, 2), row: clamp(Math.floor(((x.pos[2] - bounds.min[1]) / (D || 1)) * 3), 0, 2) });
  const NAMES = [["SW", "S", "SE"], ["W", "center", "E"], ["NW", "N", "NE"]] as const;
  const areas: string[] = [];
  for (let row = 2; row >= 0; row--) {
    for (let col = 0; col < 3; col++) {
      const inside = solid.filter((x) => { const c = cellOf(x); return c.row === row && c.col === col; });
      if (!inside.length) continue;
      areas.push(`  ${NAMES[row]![col]!} (x ${range(bounds.min[0] + (W * col) / 3, bounds.min[0] + (W * (col + 1)) / 3)}, z ${range(bounds.min[1] + (D * row) / 3, bounds.min[1] + (D * (row + 1)) / 3)}): ${inside.length} — ${countBy(inside.map((x) => baseName(x.name)), 4)}`);
    }
  }
  lines.push(`By area (north = forward, +z; a 3 × 3 split of the bounds):`, ...areas);
  const free = largestFreeRect(shown, bounds);
  lines.push(free ? `Free space: the biggest empty rectangle is ${free.width} × ${free.depth} m at x ${range(free.box.min[0], free.box.max[0])}, z ${range(free.box.min[1], free.box.max[1])}.` : "Free space: none inside these bounds.");
  return lines.join("\n");
}

/** "Tree ×5, Crate ×2, Rock" sorted by count, the first `max` and "+N more". */
function countBy(names: readonly string[], max = 12): string {
  const n = new Map<string, number>();
  for (const x of names) n.set(x, (n.get(x) ?? 0) + 1);
  const all = [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const text = all.slice(0, max).map(([k, v]) => (v > 1 ? `${k} ×${v}` : k)).join(", ");
  return all.length > max ? `${text}, +${all.length - max} more` : text;
}
