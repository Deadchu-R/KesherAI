/**
 * Unity scenes (.unity, text YAML: Unity's default "Force Text") read for KesherAI's stand-in (RESEARCH_LOG "A game
 * scene edited in KesherAI without its engine"). Writing the YAML by hand is fragile (file ids, prefab overrides), so
 * moves are not written here: they go to a list the KesherAI Unity package applies with Undo when Unity opens.
 */

/** What an object looks like: one of Unity's built-in meshes, or a model file of the project (resolved by the route). */
export type UnityLook = { builtin: "cube" | "sphere" | "cylinder" | "capsule" | "plane" | "quad" } | { guid: string };

/** A GameObject with its Transform, as the stand-in needs it. */
export interface UnityObject {
  /**
   * The key for a move: the Transform's file id in this scene; for a placed prefab or model, "<the Transform's id in
   * its source>:<the prefab instance's id>" (the two halves of its GlobalObjectId).
   */
  id: string;
  name: string;
  /** The parent Transform's id ("0": at the scene's top). */
  parent: string;
  position: [number, number, number];
  /** A quaternion (x, y, z, w), Unity's left-handed space. */
  rotation: [number, number, number, number];
  scale: [number, number, number];
  /** A placed prefab or model (moving it is an override there). */
  prefab?: boolean;
  /** Its mesh or source, for the stand-in to show the real shape. */
  look?: UnityLook;
  /** Set by the route: the model file the look points at ("Assets/….fbx"). */
  model?: string;
  /** What is attached to it, as Unity's Inspector names them ("MeshRenderer", "BoxCollider", a script's GUID as "script:<guid>"). */
  components?: string[];
  /** A 2D sprite's picture: its GUID here, its file ("Assets/….png") once the route resolves it. */
  sprite?: string;
}

/** Unity's class ids for the components the outliner names (the Inspector's names). */
const COMPONENTS: Record<string, string> = {
  "20": "Camera", "23": "MeshRenderer", "33": "MeshFilter", "50": "Rigidbody2D", "54": "Rigidbody", "58": "CircleCollider2D", "60": "PolygonCollider2D", "61": "BoxCollider2D", "64": "MeshCollider", "65": "BoxCollider", "70": "CapsuleCollider2D", "81": "AudioListener", "82": "AudioSource", "95": "Animator", "108": "Light", "135": "SphereCollider", "136": "CapsuleCollider", "137": "SkinnedMeshRenderer", "143": "CharacterController", "195": "NavMeshAgent", "198": "ParticleSystem", "212": "SpriteRenderer", "222": "CanvasRenderer", "223": "Canvas", "156049354": "Grid", "483693784": "TilemapRenderer", "1839735485": "Tilemap",
};

/** Unity's built-in meshes (in "Library/unity default resources"), by file id. */
const BUILTIN: Record<string, "cube" | "sphere" | "cylinder" | "capsule" | "plane" | "quad"> = { "10202": "cube", "10207": "sphere", "10206": "cylinder", "10208": "capsule", "10209": "plane", "10210": "quad" };
const BUILTIN_GUID = "0000000000000000e000000000000000";

/** `{x: 1, y: 2.5, z: -3}` → the numbers, by key. */
function vec(s: string | undefined, keys: string[], fallback: number[]): number[] {
  if (!s) return fallback;
  return keys.map((k, i) => {
    const m = new RegExp(`\\b${k}:\\s*(-?[\\d.]+(?:e[-+]?\\d+)?)`, "i").exec(s);
    return m ? Number(m[1]) : fallback[i]!;
  });
}

/** `{fileID: 123, guid: abc, type: 3}` → its parts. */
function ref(s: string | undefined): { fileID: string; guid?: string } | undefined {
  const m = /fileID:\s*(-?\d+)(?:,\s*guid:\s*([0-9a-f]{32}))?/.exec(s ?? "");
  return m ? { fileID: m[1]!, ...(m[2] ? { guid: m[2] } : {}) } : undefined;
}

/**
 * The scene's objects that have a Transform, with their names and looks; placed prefabs and models too (their place
 * is in the prefab instance's overrides, their look in their source file).
 *
 * @param text - The .unity file.
 * @returns The objects, parents before children where the file has them so.
 */
export function readUnityScene(text: string): UnityObject[] {
  if (!/^%YAML/.test(text) || !/--- !u!/.test(text)) throw new Error("This is not a Unity scene saved as text (Edit → Project Settings → Editor → Asset Serialization: Force Text).");
  const docs = text.split(/^--- !u!/m).slice(1);
  const names = new Map<string, string>();
  const looks = new Map<string, UnityLook>();
  /** Every document's class, and a MonoBehaviour's script / a SpriteRenderer's sprite, to name each GameObject's components. */
  const classOf = new Map<string, string>(), scriptOf = new Map<string, string>(), spriteOf = new Map<string, string>();
  const parts = new Map<string, string[]>();
  /** A stripped Transform (a prefab's, named here only as some object's parent) → its prefab instance. */
  const strippedOf = new Map<string, string>();
  const transforms: Array<Omit<UnityObject, "name"> & { go: string }> = [];
  const placed: UnityObject[] = [];
  for (const d of docs) {
    const head = /^(\d+) &(-?\d+)( stripped)?/.exec(d);
    if (!head) continue;
    const [, cls, id, stripped] = head;
    const field = (k: string) => new RegExp(`^\\s+${k}:\\s*(.*)$`, "m").exec(d)?.[1];
    classOf.set(id!, cls!);
    if (cls === "114") { const g = ref(field("m_Script"))?.guid; if (g) scriptOf.set(id!, g); }
    if (cls === "212") { const g = ref(field("m_Sprite"))?.guid; if (g) spriteOf.set(id!, g); }
    if (cls === "1") {
      names.set(id!, (field("m_Name") ?? "").trim());
      parts.set(id!, [...d.matchAll(/- component:\s*\{fileID:\s*(-?\d+)/g)].map((m) => m[1]!));
    } else if ((cls === "4" || cls === "224") && stripped) {
      const pi = ref(field("m_PrefabInstance"))?.fileID;
      if (pi && pi !== "0") strippedOf.set(id!, pi);
    } else if (cls === "4" || cls === "224") {
      // Transform, or RectTransform (UI): both have the local position, rotation and scale.
      transforms.push({
        id: id!,
        go: ref(field("m_GameObject"))?.fileID ?? "0",
        parent: ref(field("m_Father"))?.fileID ?? "0",
        position: vec(field("m_LocalPosition"), ["x", "y", "z"], [0, 0, 0]) as [number, number, number],
        rotation: vec(field("m_LocalRotation"), ["x", "y", "z", "w"], [0, 0, 0, 1]) as [number, number, number, number],
        scale: vec(field("m_LocalScale"), ["x", "y", "z"], [1, 1, 1]) as [number, number, number],
      });
    } else if (cls === "33") {
      // MeshFilter: the object's mesh.
      const go = ref(field("m_GameObject"))?.fileID;
      const mesh = ref(field("m_Mesh"));
      if (go && mesh?.guid === BUILTIN_GUID && BUILTIN[mesh.fileID]) looks.set(go, { builtin: BUILTIN[mesh.fileID]! });
      else if (go && mesh?.guid) looks.set(go, { guid: mesh.guid });
    } else if (cls === "1001") {
      // A placed prefab or model: its place and name are overrides of its root's properties.
      const src = ref(field("m_SourcePrefab"));
      const p = [0, 0, 0], r = [0, 0, 0, 1], sc = [1, 1, 1];
      let target: string | undefined, name: string | undefined;
      const mods = d.matchAll(/- target:\s*(\{[^}]*\})\s*\n\s*propertyPath:\s*(\S+)\s*\n\s*value:\s*(.*)/g);
      for (const [, t, path, value] of mods) {
        const m = /^m_Local(Position|Rotation|Scale)\.([xyzw])$/.exec(path!);
        if (m) {
          target ??= ref(t)?.fileID;
          const arr = m[1] === "Position" ? p : m[1] === "Rotation" ? r : sc;
          arr["xyzw".indexOf(m[2]!)] = Number(value);
        } else if (path === "m_Name") name = value!.trim();
      }
      if (!target) continue;
      placed.push({
        id: `${target}:${id}`,
        name: name || `Prefab ${id}`,
        parent: ref(field("m_TransformParent"))?.fileID ?? "0",
        position: p as [number, number, number],
        rotation: r as [number, number, number, number],
        scale: sc as [number, number, number],
        prefab: true,
        ...(src?.guid ? { look: { guid: src.guid } } : {}),
      });
    }
  }
  const byInstance = new Map(placed.map((o) => [o.id.split(":")[1]!, o.id]));
  /** A parent that is a prefab's inner Transform: the placed prefab stands for it. */
  const parentOf = (id: string) => (strippedOf.has(id) ? byInstance.get(strippedOf.get(id)!) ?? "0" : id);
  const attached = (go: string) => {
    const list = (parts.get(go) ?? []).flatMap((c) => {
      const k = classOf.get(c);
      if (k === "114") return scriptOf.has(c) ? [`script:${scriptOf.get(c)}`] : ["MonoBehaviour"];
      return k && COMPONENTS[k] ? [COMPONENTS[k]!] : [];
    });
    const sprite = (parts.get(go) ?? []).map((c) => spriteOf.get(c)).find(Boolean);
    return { ...(list.length ? { components: list } : {}), ...(sprite ? { sprite } : {}) };
  };
  const own = transforms.map(({ go, ...t }) => ({ ...t, parent: parentOf(t.parent), name: names.get(go) || `Object ${t.id}`, ...(looks.has(go) ? { look: looks.get(go)! } : {}), ...attached(go) }));
  return [...own, ...placed.map((o) => ({ ...o, parent: parentOf(o.parent) }))];
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
