/**
 * Which inline action buttons a tool result gets (design ChatQuickActions): pure rules, no React, so they are tested
 * on their own. A button either runs a tool directly with inputs known from the result (no model turn, no tokens;
 * `POST /api/conversations/:id/quick-actions`) or does something on the page (open the side canvas, the engine's
 * page, save, undo the run).
 */

/** A tool call and its result, as the chat has them (only the fields the rules read). */
export interface ActionStep {
  call: { callId: string; name: string; input: Record<string, unknown> };
  result?: { ok: boolean; output: string; diff?: string; assetIds?: string[]; videoIds?: string[]; audioIds?: string[] };
}

/** What pressing a button does. */
export type ActionDo =
  | { tool: string; input: Record<string, unknown>; times?: number }
  | { page: "canvas-image"; assetId: string }
  | { page: "canvas-diff"; diff: string; title: string }
  | { page: "canvas-pbr"; maps: Record<string, string>; title: string }
  | { page: "engine"; hash: string }
  | { page: "save"; assetId: string; kind: "audio" | "video" }
  | { page: "undo-run"; run: string };

/** One button: its key, both labels, its icon and what it does. */
export interface ResultAction {
  id: string;
  he: string;
  en: string;
  icon: string;
  do: ActionDo;
}

/** PBR map names, in the grid's order. */
export const PBR_ORDER = ["albedo", "normal", "roughness", "smoothness", "metallic", "ao", "height"] as const;
const ASSET_ID = /^[0-9a-f-]{36}$/;
/** Engine tools, and the page each opens. */
const ENGINE = /^(unity|unreal|godot)_/;

/**
 * The buttons under one picture a tool made.
 *
 * @param assetId - The picture.
 * @param step - The step that made it (its prompt makes "4 variations").
 * @param can - The tools this chat's buttons can run (`GET …/quick-actions`).
 * @returns The buttons, in the order they show.
 */
export function imageActions(assetId: string, step: ActionStep | undefined, can: readonly string[]): ResultAction[] {
  const has = (n: string) => can.includes(n);
  const out: ResultAction[] = [{ id: "canvas", he: "פתיחה בקנבס", en: "Open in canvas", icon: "⤢", do: { page: "canvas-image", assetId } }];
  if (has("upscale_image")) out.push({ id: "upscale", he: "הגדלה ×4", en: "Upscale ×4", icon: "⇱", do: { tool: "upscale_image", input: { asset: assetId } } });
  const prompt = step?.call.name === "generate_image" && typeof step.call.input.prompt === "string" ? step.call.input.prompt : "";
  if (prompt && has("generate_image")) {
    const size = ["width", "height"].flatMap((k) => (typeof step!.call.input[k] === "number" ? [[k, step!.call.input[k]] as const] : []));
    out.push({ id: "variations", he: "4 וריאציות", en: "4 variations", icon: "⧉", do: { tool: "generate_image", input: { prompt, ...Object.fromEntries(size), ...(typeof step!.call.input.negative_prompt === "string" ? { negative_prompt: step!.call.input.negative_prompt } : {}) }, times: 4 } });
  }
  if (has("remove_background")) out.push({ id: "nobg", he: "הסרת רקע", en: "Remove background", icon: "✂", do: { tool: "remove_background", input: { asset: assetId } } });
  // A PBR set's albedo: its set's own buttons (pbrActions) put it into Unity, as a material.
  if (step?.call.name === "make_pbr_texture") return out;
  if (has("unity_import_sprite")) out.push({ id: "unity", he: "ייבוא ל-Unity", en: "Import to Unity", icon: "⬡", do: { tool: "unity_import_sprite", input: { file: assetId } } });
  if (has("unity_create_pbr_material")) out.push({ id: "texture", he: "שימוש כטקסטורה", en: "Use as texture", icon: "▦", do: { tool: "unity_create_pbr_material", input: { name: `Kesher ${assetId.slice(0, 6)}`, maps: { albedo: assetId } } } });
  return out;
}

/**
 * The buttons under a sound or video a tool made: Save (into the chat's files) and Transcribe.
 *
 * @param assetId - The file.
 * @param kind - Sound or video.
 * @param can - The tools this chat's buttons can run.
 */
export function playerActions(assetId: string, kind: "audio" | "video", can: readonly string[]): ResultAction[] {
  const out: ResultAction[] = [{ id: "save", he: "שמירה לקבצי הצ'אט", en: "Save to chat files", icon: "⤓", do: { page: "save", assetId, kind } }];
  if (can.includes("transcribe_audio")) out.push({ id: "transcribe", he: "תמלול", en: "Transcribe", icon: "✎", do: { tool: "transcribe_audio", input: { asset: assetId } } });
  return out;
}

/**
 * A PBR map set a step used or made: the `maps` of its input (unity_create_pbr_material, or any tool given maps),
 * when they are library pictures.
 *
 * @param step - The step.
 * @returns Map name → asset id, or undefined when there are fewer than two.
 */
export function pbrMaps(step: ActionStep): Record<string, string> | undefined {
  const maps = step.call.input.maps;
  if (!maps || typeof maps !== "object" || Array.isArray(maps)) return undefined;
  const found = Object.fromEntries(PBR_ORDER.flatMap((k) => {
    const v = (maps as Record<string, unknown>)[k];
    return typeof v === "string" && ASSET_ID.test(v) ? [[k, v] as const] : [];
  }));
  return Object.keys(found).length >= 2 ? found : undefined;
}

/**
 * The PBR sets make_pbr_texture made, read from its result's "Set N: albedo=<id> normal=<id> …" lines.
 *
 * @param step - The step.
 * @returns Each set's maps (map name → asset id), in order; empty for any other step.
 */
export function pbrSets(step: ActionStep): Array<Record<string, string>> {
  if (step.call.name !== "make_pbr_texture" || !step.result?.ok) return [];
  return [...step.result.output.matchAll(/^Set \d+: (.+)$/gm)].flatMap((m) => {
    const maps = Object.fromEntries([...m[1]!.matchAll(/\b(\w+)=([0-9a-f-]{36})\b/g)].filter((x) => (PBR_ORDER as readonly string[]).includes(x[1]!)).map((x) => [x[1]!, x[2]!]));
    return Object.keys(maps).length >= 2 ? [maps] : [];
  });
}

/** The material name make_pbr_texture gave its sets (`Made … set(s) "Name" with …`). */
function pbrName(step: ActionStep): string {
  return /set\(s\) "([^"\n]{1,60})"/.exec(step.result?.output ?? "")?.[1] ?? (typeof step.call.input.name === "string" ? step.call.input.name : "PBR");
}

/**
 * The buttons under a PBR set make_pbr_texture made (design ChatPbrFlow): the maps in the side canvas, Apply to
 * selected in Unity (a URP/Built-in Lit material on the selection, one Undo step, asked first), Save as material
 * (into the project, on nothing), and 4 variations of the same words. With several sets, each gets its canvas and
 * Apply buttons, numbered.
 *
 * @param step - The make_pbr_texture step.
 * @param can - The tools this chat's buttons can run.
 */
export function pbrActions(step: ActionStep, can: readonly string[]): ResultAction[] {
  const sets = pbrSets(step);
  if (!sets.length) return [];
  const name = pbrName(step);
  const unity = can.includes("unity_create_pbr_material");
  // Unity's materials read albedo, normal, roughness and AO (height stays in the library).
  const forUnity = (maps: Record<string, string>) => Object.fromEntries(Object.entries(maps).filter(([k]) => k !== "height"));
  const out: ResultAction[] = [];
  sets.forEach((maps, i) => {
    const n = sets.length > 1 ? ` ${i + 1}` : "";
    const title = `${name}${n}`;
    out.push({ id: `pbr${n}`, he: `מפות PBR בקנבס${n}`, en: `PBR maps in canvas${n}`, icon: "▦", do: { page: "canvas-pbr", maps, title } });
    if (unity) out.push({ id: `apply${n}`, he: `החלה על הנבחר ב-Unity${n}`, en: `Apply to selected in Unity${n}`, icon: "⬡", do: { tool: "unity_create_pbr_material", input: { name: title, maps: forUnity(maps), apply_to: ["selection"] } } });
    if (unity && sets.length === 1) out.push({ id: "material", he: "שמירה כחומר", en: "Save as material", icon: "⤓", do: { tool: "unity_create_pbr_material", input: { name: title, maps: forUnity(maps) } } });
  });
  const prompt = typeof step.call.input.prompt === "string" ? step.call.input.prompt : "";
  if (prompt && can.includes("make_pbr_texture")) out.push({ id: "variations", he: "4 וריאציות", en: "4 variations", icon: "⧉", do: { tool: "make_pbr_texture", input: { prompt, name, count: 4 } } });
  return out;
}

/**
 * The buttons under a whole step: its diff in the side canvas, a PBR set in the canvas (and a made set's own
 * buttons), and for an engine step its page and Undo (the run's receipt).
 *
 * @param step - The step (finished).
 * @param run - The run's receipt id, when the run changed files ("Undo all").
 * @param can - The tools this chat's buttons can run (for a made PBR set's buttons).
 * @returns The buttons (none for a step still running or failed).
 */
export function stepActions(step: ActionStep, run?: string, can: readonly string[] = []): ResultAction[] {
  const r = step.result;
  if (!r?.ok) return [];
  const out: ResultAction[] = [];
  const path = typeof step.call.input.path === "string" ? step.call.input.path : step.call.name;
  if (r.diff) out.push({ id: "diff", he: "פתיחה בקנבס", en: "Open in canvas", icon: "⤢", do: { page: "canvas-diff", diff: r.diff, title: path } });
  out.push(...pbrActions(step, can));
  const maps = pbrMaps(step);
  if (maps) out.push({ id: "pbr", he: "מפות PBR בקנבס", en: "PBR maps in canvas", icon: "▦", do: { page: "canvas-pbr", maps, title: typeof step.call.input.name === "string" ? step.call.input.name : "PBR" } });
  const engine = ENGINE.exec(step.call.name)?.[1];
  if (engine) {
    out.push({ id: "engine", he: `פתיחה בדף ${engine === "unity" ? "Unity" : engine === "unreal" ? "Unreal" : "Godot"}`, en: `Open ${engine === "unity" ? "Unity" : engine === "unreal" ? "Unreal" : "Godot"} page`, icon: "↗", do: { page: "engine", hash: `#/${engine}` } });
    if (run) out.push({ id: "undo", he: "ביטול השינוי", en: "Undo this change", icon: "↶", do: { page: "undo-run", run } });
  }
  return out;
}

/**
 * The results a button's run made, from the chat's events after it was pressed: the button's steps are the
 * `direct-` calls of that tool.
 *
 * @param events - The chat's events.
 * @param fromSeq - The last event's number when the button was pressed.
 * @param tool - The tool the button ran.
 * @returns Each finished run, in order, and the ids of the ones still running.
 */
export function directResults<E extends { seq: number; type: string; callId?: string; name?: string }>(events: readonly E[], fromSeq: number, tool: string): { done: E[]; running: string[] } {
  const mine = events.filter((e) => e.seq > fromSeq && e.name === tool && typeof e.callId === "string" && e.callId.startsWith("direct-"));
  const done = mine.filter((e) => e.type === "tool_result");
  const finished = new Set(done.map((e) => e.callId));
  return { done, running: mine.filter((e) => e.type === "tool_call" && !finished.has(e.callId)).map((e) => e.callId!) };
}
