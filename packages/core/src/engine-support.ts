import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Which engine versions KesherAI's engine plugins support, and the "Convert with AI" task for the others
 * (Roee, 2026-11-21: the plugins must work on every engine version he has; they are open source, so for a version
 * they do not support KesherAI offers to convert a copy with AI, warning that it may not work well).
 *
 * - Unity: the KesherAI Bridge package (integrations/unity/com.kesherai.bridge) installs on 2021.3 and newer; the graph
 *   commands through Unity's CLI need Unity 6 with the Pipeline package (docs/UNITY.md).
 * - Unreal: the KesherAI Bridge plugin (integrations/unreal/KesherAIBridge) builds on 5.1 and newer; 5.8+ also has
 *   the engine's own MCP server (docs/UNREAL.md).
 */

/** The engines with a KesherAI plugin that can be converted. */
export type PluginEngine = "unity" | "unreal";

/** What KesherAI can say about one project's engine version. */
export interface EngineSupport {
  /** false: the plugin does not support this version ("Convert with AI" is offered). */
  supported: boolean;
  /** Whether the version could be read at all (an unknown version is tried as supported). */
  known: boolean;
  /** Unity 6+ (the CLI graph commands) or Unreal 5.8+ (the engine's MCP server). */
  full: boolean;
}

/** The oldest Unity the package installs on. */
export const UNITY_MIN: readonly [number, number] = [2021, 3];
/** The oldest Unreal the plugin builds on. */
export const UNREAL_MIN: readonly [number, number] = [5, 1];

/** "2022.3.10f1" / "6000.2.0b6" / "5.4" / "UE_4.27" → [major, minor], or undefined. */
function majorMinor(version: string | undefined): [number, number] | undefined {
  const m = /(\d+)\.(\d+)/.exec(String(version ?? ""));
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

const atLeast = (v: [number, number], min: readonly [number, number]) => v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]);

/**
 * Whether the KesherAI Unity package supports a Unity version.
 *
 * @param version - The project's editor version (ProjectSettings/ProjectVersion.txt), e.g. "2022.3.16f1".
 */
export function unitySupport(version: string | undefined): EngineSupport {
  const v = majorMinor(version);
  if (!v) return { supported: true, known: false, full: false };
  return { supported: atLeast(v, UNITY_MIN), known: true, full: v[0] >= 6000 };
}

/**
 * Whether the KesherAI Unreal plugin supports an engine version.
 *
 * @param version - The project's `EngineAssociation` ("5.4"), or a source build's id (unknown: tried as supported).
 */
export function unrealSupport(version: string | undefined): EngineSupport {
  const v = majorMinor(version);
  if (!v) return { supported: true, known: false, full: false };
  return { supported: atLeast(v, UNREAL_MIN), known: true, full: atLeast(v, [5, 8]) };
}

/**
 * Reads the editor version a Unity project was saved with, from ProjectSettings/ProjectVersion.txt. Copes with a
 * byte-order mark, UTF-16 (some git or copy tools re-encode it) and the old `m_EditorVersion` without a space.
 *
 * @param dir - The project folder.
 * @returns e.g. "2022.3.10f1", or undefined when the file is missing (Unity before 5) or unreadable.
 */
export async function readUnityVersion(dir: string): Promise<string | undefined> {
  const raw = await readFile(join(dir, "ProjectSettings", "ProjectVersion.txt")).catch(() => undefined);
  if (!raw) return undefined;
  const utf16 = (raw[0] === 0xff && raw[1] === 0xfe) || (raw.length > 1 && raw[1] === 0 && raw[0] !== 0);
  const text = (utf16 ? raw.toString("utf16le") : raw.toString("utf8")).replace(/^\uFEFF/, "");
  return /m_EditorVersion:\s*([0-9][\w.]*)/.exec(text)?.[1];
}

/** Where each plugin's source is in the repository, and where an AI-converted copy goes. */
export const PLUGIN_SOURCES: Record<PluginEngine, { source: string; name: string }> = {
  unity: { source: "integrations/unity/com.kesherai.bridge", name: "the KesherAI Unity package" },
  unreal: { source: "integrations/unreal/KesherAIBridge", name: "the KesherAI Unreal plugin" },
};

/**
 * The folder of an AI-converted copy for one engine version, e.g. `integrations/unreal/KesherAIBridge-ue4.27`. The
 * task may change only this folder, so the original plugin stays untouched.
 *
 * @param engine - Unity or Unreal.
 * @param version - The target engine version.
 */
export function convertedCopyPath(engine: PluginEngine, version: string): string {
  const v = (majorMinor(version) ?? [0, 0]).join(".");
  return `${PLUGIN_SOURCES[engine].source}-${engine === "unity" ? "unity" : "ue"}${v}`;
}

/** What the "Convert with AI" task needs. */
export interface ConvertRequest {
  engine: PluginEngine;
  /** The target engine version, e.g. "4.27" or "2020.3.48f1". */
  version: string;
  /** The project's name (not its path: task files travel on a git branch). */
  project?: string;
  /** The compiler's errors, when the plugin was built and failed. */
  errors?: string[];
  /** Antigravity (one Run tap on the PC) or the local model (self-work). */
  executor?: "antigravity" | "local";
}

/**
 * The task-inbox task (packages/core/src/task-inbox.ts) that converts a copy of a plugin to an engine version it does
 * not support. Only the copy's folder is writable, so the original plugin is never changed; the result lands on the
 * task's own branch (agy/… or local/…) for review.
 *
 * @param r - The engine, version, project name, compile errors and executor (checked and cut here: it is user data).
 * @returns The fields for `TaskInbox.add`, and the copy's folder.
 * @throws Error when the engine or version is not usable.
 */
export function convertTask(r: ConvertRequest): { title: string; goal: string; acceptance: string; executor: "antigravity" | "local"; risk: "medium"; extraPaths: string[]; maxFiles: number; copy: string } {
  if (r.engine !== "unity" && r.engine !== "unreal") throw new Error("Choose Unity or Unreal.");
  const version = String(r.version ?? "").trim();
  if (!/^\d{1,4}\.\d{1,2}([\w.]{0,12})$/.test(version)) throw new Error("The engine version is not valid.");
  const { source, name } = PLUGIN_SOURCES[r.engine];
  const copy = convertedCopyPath(r.engine, version);
  const label = r.engine === "unity" ? `Unity ${version}` : `Unreal ${version}`;
  const project = String(r.project ?? "").replace(/[\r\n`]+/g, " ").trim().slice(0, 80);
  const errors = (Array.isArray(r.errors) ? r.errors : []).map((e) => String(e).replace(/[\r\n]+/g, " ").replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, "<user>").slice(0, 300)).slice(0, 20);
  const goal = [
    `Convert a copy of ${name} so it compiles and works on ${label}${project ? ` (project "${project}")` : ""}.`,
    "",
    `1. Copy every file of \`${source}/\` into \`${copy}/\` (a new folder). Do not change \`${source}/\`: the original stays as it is.`,
    `2. In the copy only, change what ${label} needs: API names and headers that differ, removed or renamed classes, the build files (${r.engine === "unreal" ? "the .uplugin's EngineVersion, Build.cs module names" : "package.json's \"unity\", asmdef references and versionDefines"}). Keep the behaviour; leave out a feature that cannot exist on ${label}, with a comment saying so.`,
    `3. Write \`${copy}/CONVERTED.md\`: the target version, what was changed, what was left out, and that it was converted by AI and may not work well.`,
    ...(errors.length ? ["", `The compiler's errors on ${label}:`, ...errors.map((e) => `- ${e}`)] : []),
  ].join("\n");
  const acceptance = [`Only files under ${copy}/ are added or changed.`, `${copy}/CONVERTED.md lists the changes and the warning.`, "No new dependencies, no downloads."].join("\n");
  return {
    title: `Convert ${r.engine === "unity" ? "the Unity package" : "the Unreal plugin"} to ${label}`,
    goal,
    acceptance,
    executor: r.executor === "local" ? "local" : "antigravity",
    risk: "medium",
    extraPaths: [`${copy}/**`],
    // The whole plugin is copied (each file counts).
    maxFiles: 60,
    copy,
  };
}
