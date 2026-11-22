// What an Unreal level without Unreal shows first (SceneStandIn board): which actors are models, brushes, lights or
// settings, and the box around what is really visible, so the view opens framed on it. Pure (no three.js, no DOM), so
// node's tests can run it; the editor turns the box into a THREE.Box3.
//
// Unreal: centimetres, Z up, left-handed. three.js: metres, Y up, right-handed. Swapping Y and Z does both turns and is
// its own inverse. Everything this file returns is in three.js's space (metres, Y up).

/** Sky, fog, post process and the like: they set the look of the level but have no place in it. */
const SETTING = /Sky|Fog|PostProcess|Atmosphere|Cloud|Lightmass|Reflection|WorldSettings|Wind|Decal|Audio|Volume/i;
/** A mesh that is a sky dome / sky sphere (the starter content's "BP_Sky_Sphere" is a Blueprint with a huge mesh). */
const SKY_MESH = /Sky/i;
/** A mesh bigger than this (metres) next to other models is a backdrop, not part of what is looked at. */
const BACKDROP = 2000;
/** A BSP brush with no bounds from the bridge is drawn as a cube of this side (metres): Unreal's default builder. */
const BRUSH_SIDE = 2;

/**
 * What an actor is for the first view.
 *
 * @param a - An actor from `GET /api/unreal/level`.
 * @returns "mesh" (a static mesh), "brush" (BSP, no mesh from the bridge), "light", "marker" (PlayerStart, camera, target
 *   point), "setting" (sky, fog, post process, volumes: not shown, not framed), "other" (anything else: a small icon)
 *   or "hidden" (a model or brush scaled to 0 on an axis: nothing to see).
 */
export function classifyActor(a) {
  const cls = String(a.class ?? "");
  const s = a.scale ?? [1, 1, 1];
  const flat = s.some((x) => x === 0);
  if (/Light/.test(cls) && !/Lightmass/i.test(cls)) return "light";
  if (/PlayerStart|Camera|TargetPoint/.test(cls)) return "marker";
  if (SETTING.test(cls) || (a.mesh && SKY_MESH.test(String(a.mesh).split("/").pop() ?? ""))) return "setting";
  if (a.mesh) return flat ? "hidden" : "mesh";
  if (/^Brush/.test(cls)) return flat ? "hidden" : "brush";
  return "other";
}

/**
 * An Unreal transform in three.js's space.
 *
 * @param p - Location (cm).
 * @param q - Rotation as a quaternion [x, y, z, w].
 * @param s - Scale.
 * @returns Location (m), quaternion and scale, each an array.
 */
export function unrealToThree(p, q, s) {
  return { p: [p[0] * 0.01, p[2] * 0.01, p[1] * 0.01], q: [-q[0], -q[2], -q[1], q[3]], s: [s[0], s[2], s[1]] };
}

/** A rotation (3x3, rows) from a quaternion. */
function rotation([x, y, z, w]) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}
const mul = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const apply = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

/** An actor's own transform as a matrix (rotation times scale) and a location, in three.js's space. */
function local(t) {
  const { p, q, s } = unrealToThree(t.position ?? [0, 0, 0], t.rotation ?? [0, 0, 0, 1], t.scale ?? [1, 1, 1]);
  const r = rotation(q);
  return { m: r.map((row) => row.map((x, j) => x * s[j])), t: p };
}
/** `a` then `b` placed inside it. */
const compose = (a, b) => ({ m: mul(a.m, b.m), t: apply(a.m, b.t).map((x, i) => x + a.t[i]) });

/**
 * Where each actor stands in the level (its parents' transforms folded in, as the stand-in's nesting does).
 *
 * @param actors - The level's actors.
 * @returns Actor id to a world matrix and location (three.js's space).
 */
export function worldTransforms(actors) {
  const byId = new Map(actors.map((a) => [a.id, a]));
  const out = new Map();
  const walk = (a, depth) => {
    if (out.has(a.id)) return out.get(a.id);
    const own = local(a);
    const parent = depth < 32 ? byId.get(a.parent) : null; // a parent loop stops at 32
    const w = parent && parent !== a ? compose(walk(parent, depth + 1), own) : own;
    out.set(a.id, w);
    return w;
  };
  actors.forEach((a) => walk(a, 0));
  return out;
}

/**
 * A brush's own box (three.js's space, local to the actor): the bridge's `bounds` ({min, max} in cm, Unreal's axes) when
 * it gives them, else a 2 m cube (it sends no BSP geometry, so a brush is drawn as a box).
 *
 * @param a - A brush actor.
 * @returns `min` and `max`, and `approx` when the size is the cube's.
 */
export function brushBox(a) {
  const b = a.bounds;
  if (Array.isArray(b?.min) && Array.isArray(b?.max) && [...b.min, ...b.max].every(Number.isFinite)) {
    const lo = unrealToThree(b.min, [0, 0, 0, 1], [1, 1, 1]).p, hi = unrealToThree(b.max, [0, 0, 0, 1], [1, 1, 1]).p;
    return { min: lo.map((x, k) => Math.min(x, hi[k])), max: lo.map((x, k) => Math.max(x, hi[k])), approx: false };
  }
  const half = BRUSH_SIDE / 2;
  return { min: [-half, -half, -half], max: [half, half, half], approx: true };
}

/** The box (three.js's space) of a local box under a transform: its eight corners moved, then boxed. */
function boxOf(t, min, max) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const c = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    const w = apply(t.m, c).map((x, k) => x + t.t[k]);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
  }
  return { min: lo, max: hi };
}
const extent = (b) => Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
const finite = (b) => b && [...b.min, ...b.max].every(Number.isFinite);

/**
 * The first view of a level: what each actor is and the box around what is visible.
 *
 * Counted in the box: models (their mesh's own box, from `meshBox`, under the actor's transform and the mesh
 * component's offset) and brushes (the bridge's `bounds` in cm when it gives them, else a 2 m cube). Left out: sky, fog,
 * post process and other settings, lights and markers, anything scaled to 0, a model not read yet, and, next to other
 * models, a backdrop over 2 km. With no model or brush at all (a level of lights and settings) the box is around the
 * lights, markers and other actors, so the view still opens on something.
 *
 * @param actors - The level's actors (`GET /api/unreal/level`): cm, Z up.
 * @param meshBox - A model's box in three.js's space (m, Y up) once its shape is read, else null: `(actor) => box`.
 * @returns `box` (min, max; or null when there is nothing to frame), `visual` (any model or brush), `parts` (each
 *   actor's kind, and its box when it has one) and `counts` per kind.
 */
export function levelFrame(actors, meshBox = () => null) {
  const world = worldTransforms(actors);
  const counts = { mesh: 0, brush: 0, light: 0, marker: 0, setting: 0, other: 0, hidden: 0 };
  const parts = [];
  for (const a of actors) {
    const kind = classifyActor(a);
    counts[kind]++;
    let box = null;
    const w = world.get(a.id);
    if (kind === "mesh") {
      const lb = meshBox(a);
      if (finite(lb)) box = boxOf(a.meshAt ? compose(w, local(a.meshAt)) : w, lb.min, lb.max);
    } else if (kind === "brush") {
      const b = brushBox(a);
      box = boxOf(w, b.min, b.max);
    }
    parts.push({ id: a.id, kind, box: finite(box) ? box : null, position: w.t });
  }
  const solid = parts.filter((p) => p.box);
  // A backdrop (a sky sphere that is not named as one) next to real models is left out of the box.
  const used = solid.some((p) => extent(p.box) <= BACKDROP) ? solid.filter((p) => extent(p.box) <= BACKDROP) : solid;
  let box = null;
  const grow = (lo, hi) => {
    box = box ? { min: box.min.map((x, k) => Math.min(x, lo[k])), max: box.max.map((x, k) => Math.max(x, hi[k])) } : { min: [...lo], max: [...hi] };
  };
  for (const p of used) grow(p.box.min, p.box.max);
  const visual = counts.mesh + counts.brush > 0;
  // Nothing to see yet: the lights, markers and the rest, a metre around each, so a lighting-only level opens framed.
  if (!box && !visual) {
    for (const p of parts) if (p.kind === "light" || p.kind === "marker" || p.kind === "other") grow(p.position.map((x) => x - 0.5), p.position.map((x) => x + 0.5));
  }
  return { box, visual, parts, counts };
}
