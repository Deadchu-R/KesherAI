import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { editorOpen, runningUnity, type UnityProcesses } from "./unity-running.js";

/**
 * Whether Unity is in Play Mode, told by the KesherAI Unity package (0.2.13 and newer): on every
 * `EditorApplication.playModeStateChanged` it writes `Temp/KesherPlay.json` as `{"event":"play","on":true|false}`.
 * Unity's CLI is not a live connection (unlike Unreal's WebSocket), so the server reads that small file. Older
 * packages never write it, so nothing happens for them.
 */

/** Where the package writes it, inside the project folder. */
export const PLAY_FILE_PARTS = ["Temp", "KesherPlay.json"] as const;

/**
 * Reads the file's text.
 *
 * @param text - The file's content.
 * @returns True or false as the package said, or undefined when it is not the file's format.
 */
export function parsePlayFile(text: string): boolean | undefined {
  try {
    const j = JSON.parse(text) as { event?: unknown; on?: unknown };
    return j.event === "play" && typeof j.on === "boolean" ? j.on : undefined;
  } catch {
    return undefined;
  }
}

/** What {@link unityInPlay} reads (replaceable in tests). */
export interface UnityPlayDeps {
  read: (file: string) => Promise<string | undefined>;
  lockfile: (project: string) => boolean;
  processes: () => Promise<UnityProcesses | undefined>;
}

const real: UnityPlayDeps = {
  read: (f) => readFile(f, "utf8").catch(() => undefined),
  lockfile: (p) => existsSync(join(p, "Temp", "UnityLockfile")),
  processes: runningUnity,
};

/**
 * Whether any of the projects has its editor in Play. A "Play on" left behind by a crash does not count: the editor
 * must still be open on the project (the lock file and a running Unity process, as the Games page decides).
 *
 * @param projects - The Unity project folders to look at.
 * @param deps - File and process readers (tests pass fakes).
 */
export async function unityInPlay(projects: string[], deps: UnityPlayDeps = real): Promise<boolean> {
  for (const project of projects) {
    const text = await deps.read(join(project, ...PLAY_FILE_PARTS));
    if (!text || parsePlayFile(text) !== true) continue;
    const lock = deps.lockfile(project);
    if (editorOpen(project, lock, lock ? await deps.processes() : undefined)) return true;
  }
  return false;
}
