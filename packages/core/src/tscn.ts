/**
 * Godot scenes (.tscn, format 3) read and changed as text, so KesherAI can show a scene and move things in it without
 * Godot (RESEARCH_LOG "A game scene edited in KesherAI without its engine"). Only the transform lines of the nodes
 * that moved are touched; everything else in the file stays byte for byte as Godot wrote it.
 */

/** A node of the scene as KesherAI's stand-in needs it. */
export interface TscnNode {
  /** Its path from the root ("." for the root, "Arm/Hand" below it): how Godot names it in `parent=`. */
  path: string;
  name: string;
  type?: string;
  /** Godot 4.6+'s id that follows a node through renames. */
  uniqueId?: string;
  /** An instanced scene (its ExtResource id), shown as one object. */
  instance?: string;
  /** 3D: the basis (x, y and z axes, 9 numbers) and the origin; 2D: position (x, y), rotation (radians) and scale. */
  transform?: { basis: number[]; origin: [number, number, number] };
  position2d?: [number, number];
  rotation2d?: number;
  scale2d?: [number, number];
}

const NUM = String.raw`-?\d+(?:\.\d+)?(?:e[-+]?\d+)?`;
// The numbers inside the brackets ("Transform3D(…)": not the 3 of its name).
const numbers = (s: string) => [...s.slice(s.indexOf("(") + 1).matchAll(new RegExp(NUM, "gi"))].map((m) => Number(m[0]));
const attr = (head: string, key: string) => new RegExp(`\\b${key}=("((?:[^"\\\\]|\\\\.)*)"|([^\\s\\]]+))`).exec(head);

/**
 * The scene's nodes, in file order.
 *
 * @param text - The .tscn file.
 * @returns Its nodes (the first is the root, path ".").
 */
export function readTscn(text: string): TscnNode[] {
  if (!/^\[gd_scene\b[^\]]*format=3/m.test(text)) throw new Error("This is not a Godot 4 scene (.tscn, format 3).");
  const out: TscnNode[] = [];
  const lines = text.split(/\r?\n/);
  let cur: TscnNode | undefined;
  for (const line of lines) {
    const head = /^\[(\w+)\s*(.*)\]\s*$/.exec(line);
    if (head) {
      cur = undefined;
      if (head[1] !== "node") continue;
      const h = head[2] ?? "";
      const name = attr(h, "name")?.[2] ?? "";
      const parent = attr(h, "parent")?.[2];
      const path = parent === undefined ? "." : parent === "." ? name : `${parent}/${name}`;
      cur = { path, name, type: attr(h, "type")?.[2], uniqueId: attr(h, "unique_id")?.[3], instance: /instance=ExtResource\("([^"]+)"\)/.exec(h)?.[1] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = /^(\w+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === "transform" && /^Transform3D\(/.test(value!)) {
      const n = numbers(value!);
      if (n.length === 12) cur.transform = { basis: n.slice(0, 9), origin: [n[9]!, n[10]!, n[11]!] };
    } else if (key === "position" && /^Vector2\(/.test(value!)) {
      const n = numbers(value!);
      cur.position2d = [n[0] ?? 0, n[1] ?? 0];
    } else if (key === "rotation" && /^-?\d/.test(value!)) cur.rotation2d = Number(value);
    else if (key === "scale" && /^Vector2\(/.test(value!)) {
      const n = numbers(value!);
      cur.scale2d = [n[0] ?? 1, n[1] ?? 1];
    }
  }
  return out;
}

/** A move made in the stand-in, for one node. */
export interface TscnChange {
  path: string;
  transform?: { basis: number[]; origin: [number, number, number] };
  position2d?: [number, number];
}

const fmt = (n: number) => {
  // As Godot writes them: plain, up to 6 decimals, no "-0".
  const r = Math.round(n * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
};

/**
 * Writes moves into the scene's text: the node's `transform = Transform3D(…)` (or `position = Vector2(…)`) line
 * replaced, or added under its heading when it had none (it was at the default). Nothing else changes.
 *
 * @param text - The .tscn file.
 * @param changes - The moves.
 * @returns The new text, and the paths that were not found.
 */
export function writeTscn(text: string, changes: readonly TscnChange[]): { text: string; missing: string[] } {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const want = new Map(changes.map((c) => [c.path, c]));
  const done = new Set<string>();
  const out: string[] = [];
  let cur: TscnChange | undefined;
  let wrote = false;
  let headAt = -1;
  const line3d = (c: TscnChange) => `transform = Transform3D(${[...c.transform!.basis, ...c.transform!.origin].map(fmt).join(", ")})`;
  const line2d = (c: TscnChange) => `position = Vector2(${c.position2d!.map(fmt).join(", ")})`;
  const flush = () => {
    // The heading had no transform line: one goes right under it (where Godot puts it).
    if (cur && !wrote) out.splice(headAt + 1, 0, cur.transform ? line3d(cur) : line2d(cur));
    cur = undefined;
    wrote = false;
  };
  for (const line of lines) {
    const head = /^\[(\w+)\s*(.*)\]\s*$/.exec(line);
    if (head) {
      flush();
      if (head[1] === "node") {
        const h = head[2] ?? "";
        const name = attr(h, "name")?.[2] ?? "";
        const parent = attr(h, "parent")?.[2];
        const path = parent === undefined ? "." : parent === "." ? name : `${parent}/${name}`;
        const c = want.get(path);
        if (c && (c.transform?.basis.length === 9 || c.position2d)) { cur = c; done.add(path); headAt = out.length; }
      }
      out.push(line);
      continue;
    }
    if (cur && cur.transform && /^transform\s*=\s*Transform3D\(/.test(line)) { out.push(line3d(cur)); wrote = true; continue; }
    if (cur && cur.position2d && /^position\s*=\s*Vector2\(/.test(line)) { out.push(line2d(cur)); wrote = true; continue; }
    out.push(line);
  }
  flush();
  return { text: out.join(nl), missing: changes.map((c) => c.path).filter((p) => !done.has(p)) };
}
