import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Who else has the same scene open (Unity Studio's real-time collaboration, simply): each person's colour, camera and
 * selection, kept in memory for a few seconds after their last word. A "room" is one engine scene (the key comes from
 * KesherAI's own page, not from the plugin); a member is one open editor (a tab), named by its device.
 *
 * Guests of a shared project (routes/guests.ts, RESEARCH_LOG "A scene together, for guests through share links") join
 * the same rooms with limits: only while the owner or a paired device is there, at most MAX_GUESTS a room, a read guest's
 * selection dropped, and never seeing a member's real id (everyone is shown by an opaque id for that room).
 */

/** A member's camera: where it is and what it looks at, and its field of view (degrees). */
export interface RoomCamera {
  p: [number, number, number];
  t: [number, number, number];
  fov: number;
}

/** One person in a room, as the others see them. */
export interface RoomMember {
  /** Opaque: a hash of the member and the room (never the device's id). */
  id: string;
  name: string;
  colour: string;
  camera?: RoomCamera;
  /** The paths (Godot) or ids (Unity, Unreal) of what they have chosen. */
  selection: string[];
  /** A guest of a shared project (the page marks them). */
  guest?: true;
}

/** What a guest may do in a room: "read" sees and is seen and follows; "edit" may also select. */
export type RoomGuest = "read" | "edit";

/** Why a beat was refused: the room is full, there are too many rooms, or (a guest) nobody of the owner's is there. */
export type RoomRefusal = { error: string; code: "full" | "rooms" | "not-open" };

/** Unity Studio's twelve: at most this many in one scene. */
export const MAX_MEMBERS = 12;
/** Guests fill at most this many of the twelve; the owner's own devices always find a seat (Figma's priority). */
export const MAX_GUESTS = 6;
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

type Stored = Omit<RoomMember, "guest"> & { seen: number; guest?: RoomGuest };

/** The rooms (one per scene), in memory only. */
export class SceneRooms {
  private rooms = new Map<string, Map<string, Stored>>();
  /** Makes the opaque ids: new on each start, so an id says nothing outside this run and this room. */
  private salt = randomBytes(16).toString("hex");

  /**
   * A member's beat: who they are, where they look and what they chose; the answer is everyone else there now.
   *
   * @param room - The scene's key (from KesherAI's page, hashed by the route).
   * @param member - The member's id (a device and a tab; from the server and the page).
   * @param name - Their name (the device's, from the server).
   * @param data - Their camera and selection, as the page sent them (checked here).
   * @param now - The time (ms), for tests.
   * @param guest - Set for a guest of a shared project: their role.
   * @returns The others in the room (and `joined` on the first beat), or why not.
   */
  beat(room: string, member: string, name: string, data: { camera?: unknown; selection?: unknown }, now = Date.now(), guest?: RoomGuest): { others: RoomMember[]; joined: boolean } | RoomRefusal {
    this.sweep(now);
    let r = this.rooms.get(room);
    // A guest only joins where the owner (or a paired device) already is, and leaves when the last of them does.
    if (guest && ![...(r?.values() ?? [])].some((m) => !m.guest)) {
      this.leave(room, member);
      return { error: "Nobody of the project's owner has this scene open now.", code: "not-open" };
    }
    if (!r) {
      if (this.rooms.size >= MAX_ROOMS) return { error: "Too many scenes are shared at once.", code: "rooms" };
      r = new Map();
      this.rooms.set(room, r);
    }
    const joined = !r.has(member);
    if (joined && guest && [...r.values()].filter((m) => m.guest).length >= MAX_GUESTS) return { error: `At most ${MAX_GUESTS} guests in one scene.`, code: "full" };
    if (joined && r.size >= MAX_MEMBERS) {
      // The owner's own device always gets a seat: the guest who came last makes room.
      const lastGuest = guest ? undefined : [...r.values()].filter((m) => m.guest).pop();
      if (!lastGuest) return { error: `At most ${MAX_MEMBERS} people in one scene.`, code: "full" };
      r.delete(lastGuest.id);
    }
    const cam = data.camera as { p?: unknown; t?: unknown; fov?: unknown } | undefined;
    const p = vec(cam?.p), t = vec(cam?.t), fov = finite(cam?.fov, 1, 179);
    // A read guest sees and is seen, but does not choose anything for the others to see.
    const selection = guest !== "read" && Array.isArray(data.selection) ? data.selection.filter((s): s is string => typeof s === "string").map((s) => s.slice(0, 300)).slice(0, 50) : [];
    // A colour no one else in the room has, kept while the member stays.
    const taken = new Set([...r.values()].filter((m) => m.id !== member).map((m) => m.colour));
    const colour = r.get(member)?.colour ?? COLOURS.find((c) => !taken.has(c)) ?? COLOURS[r.size % COLOURS.length]!;
    r.set(member, { id: member, name: name.slice(0, 60), colour, ...(p && t && fov ? { camera: { p, t, fov } } : {}), selection, seen: now, ...(guest ? { guest } : {}) });
    const others = [...r.values()].filter((m) => m.id !== member).map(({ seen: _seen, guest: g, id, ...m }) => ({ ...m, id: this.opaque(room, id), ...(g ? { guest: true as const } : {}) }));
    return { others, joined };
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

  /**
   * Takes a device out of every room at once (a guest removed or banned vanishes now, not after STALE_MS).
   *
   * @param device - The device's id (members are `<device id>:<tab>`).
   * @returns How many open editors were taken out.
   */
  kick(device: string): number {
    let n = 0;
    for (const [key, r] of this.rooms) {
      for (const id of r.keys()) if (id.startsWith(`${device}:`)) { r.delete(id); n++; }
      if (!r.size) this.rooms.delete(key);
    }
    return n;
  }

  /**
   * Whether the owner (or one of their paired devices) has this scene open now: where a guest can join.
   *
   * @param room - The scene's key.
   * @param now - The time (ms), for tests.
   * @returns True when someone who is not a guest is there.
   */
  open(room: string, now = Date.now()): boolean {
    this.sweep(now);
    return [...(this.rooms.get(room)?.values() ?? [])].some((m) => !m.guest);
  }

  private opaque(room: string, member: string): string {
    return createHash("sha256").update(`${this.salt}|${room}|${member}`).digest("hex").slice(0, 16);
  }

  private sweep(now: number): void {
    for (const [key, r] of this.rooms) {
      for (const [id, m] of r) if (now - m.seen > STALE_MS) r.delete(id);
      if (!r.size) this.rooms.delete(key);
    }
  }
}

/**
 * At most `max` beats in a second for each key (a guest's beats, counted apart from the guests' "busy" alert).
 */
export class BeatLimit {
  private times = new Map<string, number[]>();

  /**
   * @param max - Beats allowed in any one second.
   */
  constructor(private readonly max = 2) {}

  /**
   * Whether one more beat may go now.
   *
   * @param key - Who beats (a guest's device id).
   * @param now - The time (ms), for tests.
   * @returns False when it is over the limit (the route answers 429).
   */
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.times.get(key) ?? []).filter((t) => now - t < 1000);
    if (recent.length >= this.max) {
      this.times.set(key, recent);
      return false;
    }
    recent.push(now);
    this.times.set(key, recent);
    // Forgets those who went quiet, so the map stays small.
    if (this.times.size > 500) for (const [k, v] of this.times) if (!v.some((t) => now - t < 1000)) this.times.delete(k);
    return true;
  }
}

/**
 * One scene's room key, the same however the page wrote the project's folder (a Godot project with or without its
 * project.godot, a trailing slash, a link): `engine|real folder|scene`, hashed. The owner's page and a guest's route both
 * come here, so they meet in one room without the guest ever seeing the folder.
 *
 * @param raw - `engine|project folder|scene` (as plugins.tsx "room.beat" builds it), or anything else (hashed as is).
 * @returns The room's key (32 hex characters).
 */
export async function roomKey(raw: unknown): Promise<string> {
  const text = String(raw ?? "").slice(0, 2000);
  const m = /^(godot|unity)\|([^|]+)\|([^|]+)$/.exec(text);
  let canonical = text;
  if (m) {
    const dir = resolve(m[2]!.replace(/[\\/]project\.godot$/i, ""));
    const real = await realpath(dir).catch(() => dir);
    canonical = `${m[1]}|${process.platform === "win32" ? real.toLowerCase() : real}|${m[3]}`;
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
