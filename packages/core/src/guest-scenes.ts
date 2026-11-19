import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { GUEST_SECRET } from "./guests.js";

/**
 * The engine scenes a guest of a shared project may open (RESEARCH_LOG "A scene together, for guests through share
 * links"): only Godot and Unity projects inside the project's own folder ("workspace"), named by a path relative to it.
 * The guest never sends or sees an absolute path; the server turns the relative one into the folder after checking it.
 */

/** The engines a guest's stand-in can show (Unreal goes through the Bridge plugin on the owner's computer: not for guests). */
export type GuestEngine = "godot" | "unity";

/** An engine project found inside the shared folder. */
export interface GuestEngineProject {
  engine: GuestEngine;
  /** Relative to the shared folder, with "/" ("." for the folder itself). */
  project: string;
}

const SKIP = new Set(["node_modules", "Library", "Temp", "Logs", "obj", "bin", "build", "dist", "addons", "Packages"]);

/** A refusal the guests' alerts count as a try to go outside the project (403). */
const outside = () => Object.assign(new Error("That is not inside the shared project."), { statusCode: 403 });

/**
 * The engine projects in the shared folder (the folder itself and up to four levels down): a Godot project has
 * project.godot, a Unity project has Assets and ProjectSettings. Hidden folders, build output and private files are
 * skipped; at most 20.
 *
 * @param workspace - The shared project's folder.
 * @returns The projects found, with paths relative to it.
 */
export async function guestEngineProjects(workspace: string): Promise<GuestEngineProject[]> {
  const root = resolve(workspace);
  const out: GuestEngineProject[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (out.length >= 20) return;
    const rel = relative(root, d).split(sep).join("/") || ".";
    if (existsSync(join(d, "project.godot"))) {
      out.push({ engine: "godot", project: rel });
      return;
    }
    if (existsSync(join(d, "Assets")) && existsSync(join(d, "ProjectSettings"))) {
      out.push({ engine: "unity", project: rel });
      return;
    }
    if (depth >= 4) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name) || GUEST_SECRET.test(e.name)) continue;
      await walk(join(d, e.name), depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}

/**
 * The real folder of an engine project a guest named, only when it is inside the shared folder: a relative path, no
 * "..", nothing private on the way (GUEST_SECRET), and still inside after following links.
 *
 * @param workspace - The shared project's folder.
 * @param project - The path the guest sent ("." or "games/level", from guestEngineProjects).
 * @returns The project's absolute folder; throws with statusCode 403 when it is outside.
 */
export async function guestProjectFolder(workspace: string, project: unknown): Promise<string> {
  const rel = String(project ?? "").replace(/\\/g, "/");
  if (!rel || rel.length > 400 || rel.includes("\0") || isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.startsWith("/")) throw outside();
  const parts = rel.split("/").filter((p) => p && p !== ".");
  if (parts.includes("..") || parts.some((p) => p.startsWith(".") || GUEST_SECRET.test(p))) throw outside();
  const root = await realpath(resolve(workspace)).catch(() => {
    throw Object.assign(new Error("The shared project's folder is not there."), { statusCode: 404 });
  });
  const dir = await realpath(resolve(root, ...parts)).catch(() => {
    throw Object.assign(new Error("No such project in the shared folder."), { statusCode: 404 });
  });
  const back = relative(root, dir);
  if (isAbsolute(back) || back.split(sep).includes("..")) throw outside();
  return dir;
}

/**
 * Whether a file a guest asks for (a scene, a model it uses) is a private one by its path.
 *
 * @param path - The path inside the engine project ("res://…" or "Assets/…").
 * @returns True when a guest may not have it.
 */
export function guestPathPrivate(path: unknown): boolean {
  const rel = String(path ?? "").replace(/^res:\/\//, "").replace(/\\/g, "/");
  return GUEST_SECRET.test(rel) || rel.split("/").includes("..");
}
