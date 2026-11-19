/**
 * Who else has the same scene open (Unity Studio's real-time collaboration, simply): each person's colour, camera and
 * selection, kept in memory for a few seconds after their last word. A "room" is one engine scene (the key comes from
 * KesherAI's own page, not from the plugin); a member is one open editor (a tab), named by its device.
 */

/** A member's camera: where it is and what it looks at, and its field of view (degrees). */
export interface RoomCamera {
  p: [number, number, number];
  t: [number, number, number];
  fov: number;
}

/** One person in a room, as the others see them. */
export interface RoomMember {
  id: string;
  name: string;
  colour: string;
  camera?: RoomCamera;
  /** The paths (Godot) or ids (Unity, Unreal) of what they have chosen. */
  selection: string[];
}

/** Unity Studio's twelve: at most this many in one scene. */
export const MAX_MEMBERS = 12;
const MAX_ROOMS = 50;
/** A member leaves when not heard from for this long (they beat about once a second). */
const STALE_MS = 6000;
/** Twelve colours that differ on a dark background, as Unity Studio gives each participant one. */
const COLOURS = ["#ff6b6b", "#4dabf7", "#69db7c", "#ffd43b", "#da77f2", "#ff922b", "#3bc9db", "#f783ac", "#a9e34b", "#9775fa", "#20c997", "#e599f7"];

const finite = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
const vec = (v: unknown): [number, number, number] | undefined => {
  if (!Array.isArray(v) || v.length !== 3) return undefined;
  const xs = v.map((x) => finite(x, -1e6, 1e6));
  return xs.every((x) => x !== undefined) ? (xs as [number, number, number]) : undefined;
};

/** The rooms (one per scene), in memory only. */
export class SceneRooms {
  private rooms = new Map<string, Map<string, RoomMember & { seen: number }>>();

  /**
   * A member's beat: who they are, where they look and what they chose; the answer is everyone else there now.
   *
   * @param room - The scene's key (from KesherAI's page).
   * @param member - The member's id (a device and a tab; from the server and the page).
   * @param name - Their name (the device's, from the server).
   * @param data - Their camera and selection, as the page sent them (checked here).
   * @param now - The time (ms), for tests.
   * @returns The others in the room, or an error when it is full.
   */
  beat(room: string, member: string, name: string, data: { camera?: unknown; selection?: unknown }, now = Date.now()): { others: RoomMember[] } | { error: string } {
    this.sweep(now);
    let r = this.rooms.get(room);
    if (!r) {
      if (this.rooms.size >= MAX_ROOMS) return { error: "Too many scenes are shared at once." };
      r = new Map();
      this.rooms.set(room, r);
    }
    if (!r.has(member) && r.size >= MAX_MEMBERS) return { error: `At most ${MAX_MEMBERS} people in one scene.` };
    const cam = data.camera as { p?: unknown; t?: unknown; fov?: unknown } | undefined;
    const p = vec(cam?.p), t = vec(cam?.t), fov = finite(cam?.fov, 1, 179);
    const selection = Array.isArray(data.selection) ? data.selection.filter((s): s is string => typeof s === "string").map((s) => s.slice(0, 300)).slice(0, 50) : [];
    // A colour no one else in the room has, kept while the member stays.
    const taken = new Set([...r.values()].filter((m) => m.id !== member).map((m) => m.colour));
    const colour = r.get(member)?.colour ?? COLOURS.find((c) => !taken.has(c)) ?? COLOURS[r.size % COLOURS.length]!;
    r.set(member, { id: member, name: name.slice(0, 60), colour, ...(p && t && fov ? { camera: { p, t, fov } } : {}), selection, seen: now });
    return { others: [...r.values()].filter((m) => m.id !== member).map(({ seen: _seen, ...m }) => m) };
  }

  /**
   * A member closed the scene.
   *
   * @param room - The scene's key.
   * @param member - The member's id.
   */
  leave(room: string, member: string): void {
    this.rooms.get(room)?.delete(member);
    if (!this.rooms.get(room)?.size) this.rooms.delete(room);
  }

  private sweep(now: number): void {
    for (const [key, r] of this.rooms) {
      for (const [id, m] of r) if (now - m.seen > STALE_MS) r.delete(id);
      if (!r.size) this.rooms.delete(key);
    }
  }
}
