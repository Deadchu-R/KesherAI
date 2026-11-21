import { EDITOR_FILES, SLOT, isEditor } from "./editor-handoff";

/** What a page was opened with: the file, and the hand-off between editors when there is one. */
export interface PageInput {
  conversationId: string;
  path: string;
  /** The video editor: a new sound from the sound editor. */
  sound?: string;
  /** The sound editor: the video it came from. */
  returnVideo?: string;
  /** A hand-off (docs/RESEARCH_LOG "editors that work alone but together"): the editor and file to go back to. */
  returnTo?: { plugin: string; path: string; slot: string };
  /** Back from a hand-off: the new file, for the slot it was made for. */
  back?: { path: string; slot: string };
  /** A guide drawn over the file and never saved (a model's UV layout over its texture). */
  guide?: string;
}

const KINDS: Readonly<Record<string, RegExp | undefined>> = EDITOR_FILES;

/**
 * The chat file a page was opened with (`?c=<chat>&f=<file>`): a picture for a page that declared `image`, a video for
 * one that declared `video`, a sound for one that declared `sound`, a 3D model for `model`. A link cannot hand any page any other file.
 *
 * @param query - The part after `?`.
 * @param uses - The page's declared models.
 * @returns The chat and file (and the round trip's other file), or undefined.
 */
export function pageInput(query: string, uses: readonly string[] | undefined): PageInput | undefined {
  const q = new URLSearchParams(query);
  const c = q.get("c");
  const f = q.get("f");
  const picture = /\.(png|jpe?g|webp|gif|bmp)$/i.test(f ?? "") && uses?.includes("image");
  const video = /\.(mp4|webm|mov|m4v|mkv)$/i.test(f ?? "") && uses?.includes("video");
  const sound = /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(f ?? "") && uses?.includes("sound");
  const model = /\.(glb|gltf)$/i.test(f ?? "") && uses?.includes("model");
  if (!c || !f || !/^[\w-]{1,80}$/.test(c) || !(picture || video || sound || model)) return undefined;
  // The round trip between the editors: the video editor gets back a new sound (`a`), the sound editor knows the video
  // it came from (`ret`). Both are files of the same chat, of the right kind.
  const a = q.get("a");
  const ret = q.get("ret");
  const retp = q.get("retp");
  const slot = q.get("slot") ?? "";
  const back = q.get("back");
  const g = q.get("g");
  const handoff = !!(retp && isEditor(retp) && ret && KINDS[retp]?.test(ret) && SLOT.test(slot));
  return {
    conversationId: c,
    path: f,
    ...(video && a && /\.(wav|mp3|m4a|flac|ogg)$/i.test(a) ? { sound: a } : {}),
    ...(sound && ret && !retp && /\.(mp4|webm|mov|m4v|mkv)$/i.test(ret) ? { returnVideo: ret } : {}),
    ...(handoff ? { returnTo: { plugin: retp!, path: ret!, slot } } : {}),
    ...(back && SLOT.test(slot) && KINDS["image-editor"]!.test(back) ? { back: { path: back, slot } } : {}),
    ...(picture && g && KINDS["image-editor"]!.test(g) ? { guide: g } : {}),
  };
}

/** A Godot scene opened without Godot in the 3D editor (SceneStandIn board): the project's folder and the scene. */
export interface GodotSceneInput {
  project: string;
  scene: string;
}

/**
 * A Godot scene a page was opened with (`?gp=<project folder>&gs=res://….tscn`), only for a page that declared
 * `model`; the server checks again that the folder is a Godot project and the scene is inside it.
 *
 * @param query - The part after `?`.
 * @param uses - The page's declared models.
 * @returns The project and scene, or undefined.
 */
export function godotSceneInput(query: string, uses: readonly string[] | undefined): GodotSceneInput | undefined {
  const q = new URLSearchParams(query);
  const project = q.get("gp") ?? "";
  const scene = q.get("gs") ?? "";
  if (!uses?.includes("model") || !project || project.length > 400 || /[\0]/.test(project)) return undefined;
  if (!/^res:\/\/[^\0]{1,300}\.tscn$/i.test(scene) || scene.split("/").includes("..")) return undefined;
  return { project, scene };
}

/** A Unity scene opened without Unity in the 3D editor: the project's folder and the scene ("Assets/….unity"). */
export interface UnitySceneInput {
  project: string;
  scene: string;
}

/**
 * A Unity scene a page was opened with (`?up=<project folder>&us=Assets/….unity`), only for a page that declared
 * `model`; the server checks again that it is a Unity project and the scene is really under its Assets.
 *
 * @param query - The part after `?`.
 * @param uses - The page's declared models.
 * @returns The project and scene, or undefined.
 */
export function unitySceneInput(query: string, uses: readonly string[] | undefined): UnitySceneInput | undefined {
  const q = new URLSearchParams(query);
  const project = q.get("up") ?? "";
  const scene = q.get("us") ?? "";
  if (!uses?.includes("model") || !project || project.length > 400 || /[\0]/.test(project)) return undefined;
  if (!/^Assets\/[^\0]{1,300}\.unity$/i.test(scene) || scene.split("/").includes("..")) return undefined;
  return { project, scene };
}

/** An Unreal level opened without Unreal in the 3D editor ("/Game/…"); read through the KesherAI Bridge plugin. */
export interface UnrealLevelInput {
  level: string;
  /** The project's folder, when it was chosen from the projects menu (the server checks it is one found on the computer). */
  project?: string;
}

/**
 * An Unreal level a page was opened with (`?ul=/Game/…`), only for a page that declared `model`; the server checks again.
 *
 * @param query - The part after `?`.
 * @param uses - The page's declared models.
 * @returns The level, or undefined.
 */
export function unrealLevelInput(query: string, uses: readonly string[] | undefined): UnrealLevelInput | undefined {
  const q = new URLSearchParams(query);
  const level = q.get("ul") ?? "";
  const project = q.get("upj") ?? "";
  if (!uses?.includes("model") || !/^\/Game\/[\w ./-]{1,300}$/.test(level) || level.includes("..")) return undefined;
  return { level, ...(project && project.length <= 400 && !project.includes("\0") ? { project } : {}) };
}
