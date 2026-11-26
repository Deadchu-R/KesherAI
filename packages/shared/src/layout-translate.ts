/**
 * Cross-engine layout translate between Unity YAML and Unreal stand-in (GE-28): converts a small set of layout
 * properties (position, rotation, scale) from one engine's coordinate conventions to the other's. Pure, no engine
 * access; used by the scene-diff visualizer to show "what this would look like in the other engine" beside a diff.
 *
 * Conventions:
 * - Unity: left-handed Y-up, rotation in Euler degrees (x, y, z), scale uniform or per-axis.
 * - Unreal: left-handed Z-up, rotation as pitch/yaw/roll (degrees), scale uniform (float) or per-axis vector.
 *
 * The translate is lossy (different rotation orders, handedness quirks); it is a preview, not a round-trip guarantee.
 */

/** A three-component vector used for position, rotation and scale in both engines' layout shapes. */
export interface LayoutVec3 {
 x: number;
 y: number;
 z: number;
}

/** Unity-side layout: left-handed Y-up, Euler rotation in degrees, per-axis scale. */
export interface UnityLayout {
 position: LayoutVec3;
 rotation: LayoutVec3; // Euler degrees (x, y, z)
 scale: LayoutVec3;
}

/** Unreal-side stand-in layout: Z-up location, pitch/yaw/roll rotation in degrees, per-axis scale. */
export interface UnrealLayout {
 location: LayoutVec3; // cm in Unreal, but we keep the same unit as input for preview parity
 rotation: { pitch: number; yaw: number; roll: number }; // degrees
 scale: LayoutVec3;
}

const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const vec = (v: unknown): LayoutVec3 | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const x = n(o.x);
  const y = n(o.y);
  const z = n(o.z);
  if (x === undefined || y === undefined || z === undefined) return undefined;
  return { x, y, z };
};

/**
 * Unity layout → Unreal stand-in. Position swaps Y/Z (Unity Y-up → Unreal Z-up). Rotation maps Unity Euler (x, y, z)
 * to Unreal (pitch=x, yaw=y, roll=z) as a first-order preview; scale passes through.
 */
export function unityToUnreal(u: UnityLayout): UnrealLayout {
  return {
    location: { x: u.position.x, y: u.position.z, z: u.position.y },
    rotation: { pitch: u.rotation.x, yaw: u.rotation.y, roll: u.rotation.z },
    scale: { ...u.scale },
  };
}

/**
 * Unreal stand-in → Unity layout. Inverse of `unityToUnreal`: location swaps Y/Z back, rotation maps pitch/yaw/roll
 * to Euler (x, y, z), scale passes through.
 */
export function unrealToUnity(r: UnrealLayout): UnityLayout {
  return {
    position: { x: r.location.x, y: r.location.z, z: r.location.y },
    rotation: { x: r.rotation.pitch, y: r.rotation.yaw, z: r.rotation.roll },
    scale: { ...r.scale },
  };
}

/**
 * Parse a loose Unity-layout-shaped value (from YAML or a tool's JSON) into a typed layout, or undefined when the
 * shape does not match. Tolerates missing fields; returns undefined only when position is absent.
 */
export function parseUnityLayout(v: unknown): UnityLayout | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const position = vec(o.position ?? o.localPosition);
  if (!position) return undefined;
  const rotation = vec(o.rotation ?? o.localRotation ?? o.eulerAngles) ?? { x: 0, y: 0, z: 0 };
  const scale = vec(o.scale ?? o.localScale) ?? { x: 1, y: 1, z: 1 };
  return { position, rotation, scale };
}

/**
 * Parse a loose Unreal-layout-shaped value (from a stand-in JSON or tool output) into a typed layout, or undefined
 * when the shape does not match. Tolerates missing rotation/scale; returns undefined only when location is absent.
 */
export function parseUnrealLayout(v: unknown): UnrealLayout | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const location = vec(o.location ?? o.Location);
  if (!location) return undefined;
  const rotRaw = (o.rotation ?? o.Rotation) as Record<string, unknown> | undefined;
  const pitch = n(rotRaw?.pitch ?? rotRaw?.Pitch) ?? 0;
  const yaw = n(rotRaw?.yaw ?? rotRaw?.Yaw) ?? 0;
  const roll = n(rotRaw?.roll ?? rotRaw?.Roll) ?? 0;
  const scale = vec(o.scale ?? o.Scale) ?? { x: 1, y: 1, z: 1 };
  return { location, rotation: { pitch, yaw, roll }, scale };
}