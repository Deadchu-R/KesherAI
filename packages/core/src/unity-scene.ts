/**
 * Unity scenes (.unity, text YAML: Unity's default "Force Text") read for KesherAI's stand-in (RESEARCH_LOG "A game
 * scene edited in KesherAI without its engine"). Writing the YAML by hand is fragile (file ids, prefab overrides), so
 * moves are not written here: they go to a list the KesherAI Unity package applies with Undo when Unity opens.
 */

/** A GameObject with its Transform, as the stand-in needs it. */
export interface UnityObject {
  /** The Transform's file id: stable for the object in this scene, the key for a move. */
  id: string;
  name: string;
  /** The parent Transform's id ("0": at the scene's top). */
  parent: string;
  position: [number, number, number];
  /** A quaternion (x, y, z, w), Unity's left-handed space. */
  rotation: [number, number, number, number];
  scale: [number, number, number];
  /** It belongs to a prefab placed in the scene (moving its root is an override there). */
  prefab?: boolean;
}

/** `{x: 1, y: 2.5, z: -3}` → the numbers, by key. */
function vec(s: string | undefined, keys: string[], fallback: number[]): number[] {
  if (!s) return fallback;
  return keys.map((k, i) => {
    const m = new RegExp(`\\b${k}:\\s*(-?[\\d.]+(?:e[-+]?\\d+)?)`, "i").exec(s);
    return m ? Number(m[1]) : fallback[i]!;
  });
}

/**
 * The scene's objects that have a Transform, with their names.
 *
 * @param text - The .unity file.
 * @returns The objects, parents before children where the file has them so.
 */
export function readUnityScene(text: string): UnityObject[] {
  if (!/^%YAML/.test(text) || !/--- !u!/.test(text)) throw new Error("This is not a Unity scene saved as text (Edit → Project Settings → Editor → Asset Serialization: Force Text).");
  const docs = text.split(/^--- !u!/m).slice(1);
  const names = new Map<string, string>();
  const prefabbed = new Set<string>();
  const transforms: Array<Omit<UnityObject, "name"> & { go: string }> = [];
  for (const d of docs) {
    const head = /^(\d+) &(-?\d+)( stripped)?/.exec(d);
    if (!head) continue;
    const [, cls, id] = head;
    const field = (k: string) => new RegExp(`^\\s+${k}:\\s*(.*)$`, "m").exec(d)?.[1];
    if (cls === "1") {
      names.set(id!, (field("m_Name") ?? "").trim());
      if (/m_PrefabInstance:\s*\{fileID:\s*[1-9]/.test(d)) prefabbed.add(id!);
    } else if (cls === "4" || cls === "224") {
      // Transform, or RectTransform (UI): both have the local position, rotation and scale.
      const go = /m_GameObject:\s*\{fileID:\s*(-?\d+)/.exec(d)?.[1] ?? "0";
      transforms.push({
        id: id!,
        go,
        parent: /m_Father:\s*\{fileID:\s*(-?\d+)/.exec(d)?.[1] ?? "0",
        position: vec(field("m_LocalPosition"), ["x", "y", "z"], [0, 0, 0]) as [number, number, number],
        rotation: vec(field("m_LocalRotation"), ["x", "y", "z", "w"], [0, 0, 0, 1]) as [number, number, number, number],
        scale: vec(field("m_LocalScale"), ["x", "y", "z"], [1, 1, 1]) as [number, number, number],
      });
    }
  }
  return transforms.map(({ go, ...t }) => ({ ...t, name: names.get(go) || `Object ${t.id}`, ...(prefabbed.has(go) ? { prefab: true } : {}) }));
}

/** A move for the Unity package to apply (local position, rotation and scale of one Transform). */
export interface UnityMove {
  id: string;
  name: string;
  /** What it was when the stand-in was made, to tell a clash. */
  from: { position: number[]; rotation: number[]; scale: number[] };
  to: { position: number[]; rotation: number[]; scale: number[] };
}

/**
 * The moves the package applies when Unity opens (KesherAI/pending-moves.json in the project): per scene, merged with
 * those already waiting (a newer move of the same object replaces the older one, keeping the first "from").
 *
 * @param waiting - The file's moves now.
 * @param scene - The scene's path in the project ("Assets/…unity").
 * @param moves - The new moves.
 * @returns The new contents.
 */
export function mergeMoves(waiting: Record<string, UnityMove[]>, scene: string, moves: readonly UnityMove[]): Record<string, UnityMove[]> {
  const list = new Map((waiting[scene] ?? []).map((m) => [m.id, m]));
  for (const m of moves) list.set(m.id, { ...m, from: list.get(m.id)?.from ?? m.from });
  return { ...waiting, [scene]: [...list.values()] };
}
