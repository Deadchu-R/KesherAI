import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute } from "node:path";
import type { AgentTool, ToolContext } from "@kesher/agent";
import { csString, projectPath } from "./unity-tools.js";

/**
 * Unity scene tools that read and change one object at a time (RESEARCH_LOG "Usability gap list against the code
 * (2026-11-20)", Area 3): a compact hierarchy first (names, ids, child counts), then one object's components and
 * fields on demand, so a big scene costs few tokens. Everything runs as C# in the open Editor through Unity's CLI
 * (`script eval`); user text reaches the C# only as escaped string literals (`csString`) and checked numbers.
 */

/** What the edit tools need from `unityTools`: the project, a "no project" check and C# in the open Editor. */
export interface UnityEditDeps {
  /** The active Unity project folder. */
  project: () => string | undefined;
  /** Throws the "pick a project first" message when there is no project. */
  need: () => void;
  /** Runs C# in the open Editor and returns what it returns (or a plain-words failure). */
  evalCs: (code: string) => Promise<string>;
  /** Reads a picture of KesherAI's library by its id (a generated image), for the import tools. */
  readAsset?: (id: string) => Promise<{ data: Uint8Array; mimeType: string } | undefined>;
}

/** Whole numbers in a range, with a default for anything else. */
export const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && v !== undefined && v !== null && v !== "" ? Math.min(max, Math.max(min, n)) : dflt;
};

/**
 * C# shared by the scene tools: the loaded scenes, `PathOf(transform)` ("Level/Door") and `Resolve(key)`, which finds
 * a GameObject by its id from the hierarchy ("#-1234" or "-1234") or by its path, inactive objects included (unlike
 * `GameObject.Find`).
 */
export const SCENE_PRELUDE = `var kScenes = new System.Collections.Generic.List<UnityEngine.SceneManagement.Scene>();
for (var si = 0; si < UnityEngine.SceneManagement.SceneManager.sceneCount; si++) { var s0 = UnityEngine.SceneManagement.SceneManager.GetSceneAt(si); if (s0.isLoaded) kScenes.Add(s0); }
System.Func<UnityEngine.Transform, string> PathOf = null;
PathOf = t => t.parent == null ? t.name : PathOf(t.parent) + "/" + t.name;
System.Func<string, UnityEngine.GameObject> Resolve = key => {
  key = (key ?? "").Trim();
  var digits = key.StartsWith("#") ? key.Substring(1) : key;
  int id; var byId = int.TryParse(digits, out id);
  var path = key.TrimStart('/');
  UnityEngine.GameObject byPath = null;
  foreach (var sc in kScenes) foreach (var r in sc.GetRootGameObjects()) foreach (var t in r.GetComponentsInChildren<UnityEngine.Transform>(true)) {
    if (byId && t.gameObject.GetInstanceID() == id) return t.gameObject;
    if (byPath == null && !key.StartsWith("#") && PathOf(t) == path) byPath = t.gameObject;
  }
  return byPath;
};`;

/**
 * C# for the compact hierarchy: one line per object with its id, child count and whether it is inactive; no
 * components (unity_inspect_object gives those).
 *
 * @param o.depth - Levels below the top (or below `root`) to show; deeper children are counted, not listed.
 * @param o.filter - Only objects whose name contains this (any depth, shown with their full path).
 * @param o.root - Start from this object (id or path) instead of the scene's top.
 * @param o.limit - At most this many lines; the rest are counted.
 */
export function hierarchyCs(o: { depth: number; filter: string; root: string; limit: number }): string {
  return `${SCENE_PRELUDE}
var sb = new System.Text.StringBuilder(); var count = 0; var more = 0;
var maxDepth = ${o.depth}; var limit = ${o.limit};
var filter = ${csString(o.filter.toLowerCase())};
var rootKey = ${csString(o.root)};
foreach (var sc in kScenes) sb.AppendLine("Scene: " + (sc.path == "" ? "(new, never saved)" : sc.path) + (sc.isDirty ? " (unsaved changes)" : ""));
sb.AppendLine("Each line: name #id (children). Use the #id with unity_inspect_object and unity_modify_scene.");
System.Action<UnityEngine.Transform, int> walk = null;
walk = (t, d) => {
  var hit = filter == "" || t.name.ToLowerInvariant().Contains(filter);
  if (hit) {
    if (count >= limit) more++;
    else {
      count++;
      var kids = t.childCount == 0 ? "" : " (" + t.childCount + (filter == "" && d >= maxDepth ? " children, not shown)" : " children)");
      sb.AppendLine((filter == "" ? new string(' ', d * 2) + t.name : PathOf(t)) + " #" + t.gameObject.GetInstanceID() + kids + (t.gameObject.activeSelf ? "" : " (inactive)"));
    }
  }
  if (d < (filter == "" ? maxDepth : 50)) foreach (UnityEngine.Transform ch in t) walk(ch, d + 1);
};
if (rootKey != "") {
  var start = Resolve(rootKey);
  if (start == null) return "No GameObject " + rootKey + " in the open scene.";
  walk(start.transform, 0);
} else foreach (var sc in kScenes) foreach (var r in sc.GetRootGameObjects()) walk(r.transform, 0);
if (count == 0) sb.AppendLine(filter == "" ? "(no objects)" : "No object's name contains that.");
if (more > 0) sb.AppendLine("… " + more + " more: narrow it with filter, root or depth.");
return sb.ToString();`;
}

/**
 * C# that lists one object's components and their serialized fields (property path = value), at most `limit` fields
 * per component, with a hint for the rest.
 *
 * @param key - The object's id ("#-1234") or path.
 * @param component - Only this component (type name), or "" for all.
 * @param limit - Fields per component.
 */
export function inspectCs(key: string, component: string, limit: number): string {
  return `${SCENE_PRELUDE}
var go = Resolve(${csString(key)});
if (go == null) return "No GameObject " + ${csString(key)} + " in the open scene (see unity_scene hierarchy).";
var only = ${csString(component)}; var cap = ${limit};
var sb = new System.Text.StringBuilder();
var tr = go.transform;
sb.AppendLine(PathOf(tr) + " #" + go.GetInstanceID() + (go.activeSelf ? "" : " (inactive)") + (go.activeInHierarchy || !go.activeSelf ? "" : " (a parent is inactive)") + ", tag " + go.tag + ", layer " + UnityEngine.LayerMask.LayerToName(go.layer) + (go.isStatic ? ", static" : "") + ", " + tr.childCount + " children");
sb.AppendLine("Transform: local position " + tr.localPosition + ", rotation " + tr.localEulerAngles + ", scale " + tr.localScale + "; world position " + tr.position);
System.Func<UnityEditor.SerializedProperty, string> Val = p => {
  switch (p.propertyType) {
    case UnityEditor.SerializedPropertyType.Integer: case UnityEditor.SerializedPropertyType.LayerMask: case UnityEditor.SerializedPropertyType.Character: return p.intValue.ToString();
    case UnityEditor.SerializedPropertyType.Boolean: return p.boolValue ? "true" : "false";
    case UnityEditor.SerializedPropertyType.Float: return p.floatValue.ToString("0.###");
    case UnityEditor.SerializedPropertyType.String: { var s = p.stringValue ?? ""; return "\\"" + (s.Length > 80 ? s.Substring(0, 80) + "…" : s) + "\\""; }
    case UnityEditor.SerializedPropertyType.Color: return p.colorValue.ToString();
    case UnityEditor.SerializedPropertyType.ObjectReference: { var o = p.objectReferenceValue; if (o == null) return "None"; var ap = UnityEditor.AssetDatabase.GetAssetPath(o); return o.name + " (" + o.GetType().Name + (ap != "" ? ", " + ap : "") + ")"; }
    case UnityEditor.SerializedPropertyType.Enum: return p.enumValueIndex >= 0 && p.enumValueIndex < p.enumNames.Length ? p.enumNames[p.enumValueIndex] : p.intValue.ToString();
    case UnityEditor.SerializedPropertyType.Vector2: return p.vector2Value.ToString();
    case UnityEditor.SerializedPropertyType.Vector3: return p.vector3Value.ToString();
    case UnityEditor.SerializedPropertyType.Vector4: return p.vector4Value.ToString();
    case UnityEditor.SerializedPropertyType.Vector2Int: return p.vector2IntValue.ToString();
    case UnityEditor.SerializedPropertyType.Vector3Int: return p.vector3IntValue.ToString();
    case UnityEditor.SerializedPropertyType.Rect: return p.rectValue.ToString();
    case UnityEditor.SerializedPropertyType.Bounds: return p.boundsValue.ToString();
    case UnityEditor.SerializedPropertyType.Quaternion: return "euler " + p.quaternionValue.eulerAngles;
    default: return p.isArray ? "list of " + p.arraySize : "(" + p.type + ")";
  }
};
var comps = go.GetComponents<UnityEngine.Component>();
var found = false;
foreach (var c in comps) {
  if (c == null) { if (only == "") sb.AppendLine("- Missing script"); continue; }
  var n = c.GetType().Name;
  if (only != "" && n != only && c.GetType().FullName != only) continue;
  if (only == "" && c is UnityEngine.Transform && !(c is UnityEngine.RectTransform)) continue;
  found = true;
  var bh = c as UnityEngine.Behaviour;
  sb.AppendLine("- " + n + (bh != null && !bh.enabled ? " (disabled)" : ""));
  var so = new UnityEditor.SerializedObject(c); var p = so.GetIterator(); var shown = 0; var rest = 0; var enter = true;
  while (p.NextVisible(enter)) {
    enter = false;
    if (p.propertyPath == "m_Script" || p.depth > 1) continue;
    // Open small structs one level (a field's x/y/z); lists only show their size.
    enter = p.depth == 0 && p.hasVisibleChildren && p.propertyType == UnityEditor.SerializedPropertyType.Generic && !p.isArray;
    if (shown >= cap) { rest++; continue; }
    sb.AppendLine("    " + p.propertyPath + " = " + Val(p)); shown++;
  }
  if (rest > 0) sb.AppendLine("    … " + rest + " more fields: unity_inspect_object with component '" + n + "' and a higher limit.");
}
if (only != "" && !found) sb.AppendLine("It has no component " + only + ". It has: " + string.Join(", ", System.Array.ConvertAll(comps, x => x == null ? "Missing script" : x.GetType().Name)));
return sb.ToString();`;
}

/** What `unity_modify_scene` can do to an object. */
export const SCENE_ACTIONS = ["move", "rotate", "scale", "rename", "reparent", "delete", "set_active", "set_property"] as const;
type SceneAction = (typeof SCENE_ACTIONS)[number];

/** One checked change of `unity_modify_scene`. */
export interface SceneChange {
  object: string;
  action: SceneAction;
  /** move/rotate/scale: [x, y, z]; rename: the name; reparent: the new parent ("" = the scene's top); set_active: on or off; set_property: the value. */
  value?: number[] | string | boolean | number;
  /** move/rotate: the parent's space (default) or the world's. */
  space?: "local" | "world";
  /** set_property: the component's type name ("GameObject" for the object itself) and the property path. */
  component?: string;
  property?: string;
}

const TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,120}$/;
const PROP_PATH = /^[A-Za-z_][A-Za-z0-9_.[\]]{0,200}$/;
const MAX_CHANGES = 50;
const isVec = (v: unknown, lens: number[]): v is number[] => Array.isArray(v) && lens.includes(v.length) && v.every((n) => typeof n === "number" && Number.isFinite(n));

/**
 * Checks the `changes` list of `unity_modify_scene`.
 *
 * @param list - The model's input.
 * @returns The changes, or a plain-words refusal (nothing is sent to Unity then).
 */
export function parseSceneChanges(list: unknown): SceneChange[] | string {
  if (!Array.isArray(list) || !list.length) return "changes is a list of { object, action, value }.";
  if (list.length > MAX_CHANGES) return `At most ${MAX_CHANGES} changes in one call.`;
  const out: SceneChange[] = [];
  for (const [i, raw] of list.entries()) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const at = `Change ${i + 1}`;
    const object = String(c.object ?? "").trim();
    if (!object || object.length > 300) return `${at}: give the object's #id (from unity_scene hierarchy) or its path.`;
    const action = SCENE_ACTIONS.find((a) => a === c.action);
    if (!action) return `${at}: action is one of ${SCENE_ACTIONS.join(", ")}.`;
    const ch: SceneChange = { object, action };
    if (action === "move" || action === "rotate" || action === "scale") {
      if (!isVec(c.value, [3])) return `${at}: value is [x, y, z] numbers.`;
      ch.value = c.value;
      if (action !== "scale") ch.space = c.space === "world" ? "world" : "local";
    } else if (action === "rename") {
      const name = typeof c.value === "string" ? c.value.trim() : "";
      if (!name || name.length > 120) return `${at}: value is the new name (up to 120 characters).`;
      ch.value = name;
    } else if (action === "reparent") {
      if (typeof c.value !== "string" || c.value.length > 300) return `${at}: value is the new parent's #id or path ("" for the scene's top).`;
      ch.value = c.value.trim();
    } else if (action === "set_active") {
      if (typeof c.value !== "boolean") return `${at}: value is true or false.`;
      ch.value = c.value;
    } else if (action === "set_property") {
      const component = String(c.component ?? "").trim();
      const property = String(c.property ?? "").trim();
      if (!TYPE_NAME.test(component)) return `${at}: component is a type name (e.g. Rigidbody, or GameObject for the object itself).`;
      if (!PROP_PATH.test(property)) return `${at}: property is a path from unity_inspect_object (e.g. m_Mass).`;
      const v = c.value;
      const ok = (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" || (typeof v === "string" && v.length <= 2000) || isVec(v, [2, 3, 4]);
      if (!ok) return `${at}: value is a number, true/false, text (an enum name, an asset path or an object's #id for a reference) or a list of 2-4 numbers.`;
      Object.assign(ch, { component, property, value: v });
    }
    out.push(ch);
  }
  return out;
}

/** How many objects a change list touches and how many it deletes. */
function sceneReach(changes: SceneChange[]): { objects: number; deletes: number } {
  return { objects: new Set(changes.map((c) => c.object)).size, deletes: changes.filter((c) => c.action === "delete").length };
}

/**
 * The approval reason for a change list, or undefined when it needs none: deleting, or changing more than one object,
 * is asked every time (the approval card shows the list). The web's `reasonText` translates this sentence.
 */
export function sceneAskReason(objects: number, deletes: number): string | undefined {
  if (!deletes && objects <= 1) return undefined;
  return `Changes ${objects} object${objects === 1 ? "" : "s"} in the Unity scene${deletes ? `, deleting ${deletes}` : ""}.`;
}

/** One change in words, for the approval card. */
export function describeSceneChange(c: SceneChange): string {
  const v = Array.isArray(c.value) ? `(${c.value.join(", ")})` : JSON.stringify(c.value);
  switch (c.action) {
    case "move": return `move to ${v}${c.space === "world" ? " (world)" : ""}`;
    case "rotate": return `rotate to ${v}${c.space === "world" ? " (world)" : ""}`;
    case "scale": return `scale to ${v}`;
    case "rename": return `rename to ${v}`;
    case "reparent": return c.value ? `move under ${String(c.value)}` : "move to the scene's top";
    case "delete": return "DELETE (with its children)";
    case "set_active": return c.value ? "turn on" : "turn off";
    case "set_property": return `${c.component}.${c.property} = ${v}`;
  }
}

const f = (n: number) => `${n}f`;
const vec3 = (v: number[]) => `new UnityEngine.Vector3(${v.map(f).join(", ")})`;

/** The C# for one change; `go` is its object and `objs[k]` the reparent target. */
function changeCs(c: SceneChange, parentIndex: number): string {
  const v = c.value;
  switch (c.action) {
    case "move":
      return `UnityEditor.Undo.RecordObject(go.transform, "KesherAI: move"); go.transform.${c.space === "world" ? "position" : "localPosition"} = ${vec3(v as number[])}; log.AppendLine("moved " + name + " to " + go.transform.${c.space === "world" ? "position" : "localPosition"});`;
    case "rotate":
      return `UnityEditor.Undo.RecordObject(go.transform, "KesherAI: rotate"); go.transform.${c.space === "world" ? "eulerAngles" : "localEulerAngles"} = ${vec3(v as number[])}; log.AppendLine("rotated " + name);`;
    case "scale":
      return `UnityEditor.Undo.RecordObject(go.transform, "KesherAI: scale"); go.transform.localScale = ${vec3(v as number[])}; log.AppendLine("scaled " + name + " to " + go.transform.localScale);`;
    case "rename":
      return `UnityEditor.Undo.RecordObject(go, "KesherAI: rename"); go.name = ${csString(String(v))}; log.AppendLine("renamed " + name + " to " + go.name);`;
    case "reparent":
      return parentIndex < 0
        ? `UnityEditor.Undo.SetTransformParent(go.transform, null, "KesherAI: parent"); log.AppendLine("moved " + name + " to the scene's top");`
        : `{ var np = objs[${parentIndex}].transform;
  if (np == go.transform || np.IsChildOf(go.transform)) log.AppendLine("skipped: " + name + " cannot go under itself or its own child");
  else { UnityEditor.Undo.SetTransformParent(go.transform, np, "KesherAI: parent"); log.AppendLine("moved " + name + " under " + PathOf(np)); } }`;
    case "delete":
      return `UnityEditor.Undo.DestroyObjectImmediate(go); log.AppendLine("deleted " + name);`;
    case "set_active":
      return `UnityEditor.Undo.RecordObject(go, "KesherAI: active"); go.SetActive(${v ? "true" : "false"}); log.AppendLine("turned " + name + (go.activeSelf ? " on" : " off"));`;
    case "set_property": {
      const setter = typeof v === "number" ? `SetNum(p, ${v})` : typeof v === "boolean" ? `SetBool(p, ${v})` : typeof v === "string" ? `SetStr(p, ${csString(v)})` : `SetVec(p, new float[] { ${(v as number[]).map(f).join(", ")} })`;
      return `{ var cn = ${csString(c.component!)}; UnityEngine.Object target = cn == "GameObject" ? (UnityEngine.Object)go : null;
  if (target == null) foreach (var cc in go.GetComponents<UnityEngine.Component>()) if (cc != null && (cc.GetType().Name == cn || cc.GetType().FullName == cn)) { target = cc; break; }
  if (target == null) log.AppendLine("skipped: " + name + " has no component " + cn);
  else { var so = new UnityEditor.SerializedObject(target); var p = so.FindProperty(${csString(c.property!)});
    if (p == null) log.AppendLine("skipped: " + cn + " on " + name + " has no property ${c.property} (see unity_inspect_object)");
    else { var err = ${setter}; if (err == "") { so.ApplyModifiedProperties(); log.AppendLine("set " + name + " " + cn + ".${c.property}"); } else log.AppendLine("skipped: " + err); } } }`;
    }
  }
}

/** Value setters for `set_property` (each returns "" or what was wrong). */
const SETTERS = `System.Func<UnityEditor.SerializedProperty, double, string> SetNum = (p, d) => {
  switch (p.propertyType) {
    case UnityEditor.SerializedPropertyType.Integer: case UnityEditor.SerializedPropertyType.LayerMask: case UnityEditor.SerializedPropertyType.Character: case UnityEditor.SerializedPropertyType.ArraySize: p.intValue = (int)d; return "";
    case UnityEditor.SerializedPropertyType.Float: p.floatValue = (float)d; return "";
    case UnityEditor.SerializedPropertyType.Boolean: p.boolValue = d != 0; return "";
    case UnityEditor.SerializedPropertyType.Enum: if (d < 0 || d >= p.enumNames.Length) return p.propertyPath + " has " + p.enumNames.Length + " options"; p.enumValueIndex = (int)d; return "";
    default: return p.propertyPath + " is " + p.propertyType + ", not a number";
  }
};
System.Func<UnityEditor.SerializedProperty, bool, string> SetBool = (p, b) => {
  if (p.propertyType != UnityEditor.SerializedPropertyType.Boolean) return p.propertyPath + " is " + p.propertyType + ", not true/false";
  p.boolValue = b; return "";
};
System.Func<UnityEditor.SerializedProperty, float[], string> SetVec = (p, v) => {
  var n = v.Length;
  switch (p.propertyType) {
    case UnityEditor.SerializedPropertyType.Vector2: if (n != 2) break; p.vector2Value = new UnityEngine.Vector2(v[0], v[1]); return "";
    case UnityEditor.SerializedPropertyType.Vector3: if (n != 3) break; p.vector3Value = new UnityEngine.Vector3(v[0], v[1], v[2]); return "";
    case UnityEditor.SerializedPropertyType.Vector4: if (n != 4) break; p.vector4Value = new UnityEngine.Vector4(v[0], v[1], v[2], v[3]); return "";
    case UnityEditor.SerializedPropertyType.Vector2Int: if (n != 2) break; p.vector2IntValue = new UnityEngine.Vector2Int((int)v[0], (int)v[1]); return "";
    case UnityEditor.SerializedPropertyType.Vector3Int: if (n != 3) break; p.vector3IntValue = new UnityEngine.Vector3Int((int)v[0], (int)v[1], (int)v[2]); return "";
    case UnityEditor.SerializedPropertyType.Color: if (n < 3) break; p.colorValue = new UnityEngine.Color(v[0], v[1], v[2], n == 4 ? v[3] : 1f); return "";
    case UnityEditor.SerializedPropertyType.Rect: if (n != 4) break; p.rectValue = new UnityEngine.Rect(v[0], v[1], v[2], v[3]); return "";
    case UnityEditor.SerializedPropertyType.Quaternion: if (n == 3) { p.quaternionValue = UnityEngine.Quaternion.Euler(v[0], v[1], v[2]); return ""; } if (n == 4) { p.quaternionValue = new UnityEngine.Quaternion(v[0], v[1], v[2], v[3]); return ""; } break;
    default: return p.propertyPath + " is " + p.propertyType + ", not a list of numbers";
  }
  return p.propertyPath + " (" + p.propertyType + ") does not take " + n + " numbers";
};
System.Func<UnityEditor.SerializedProperty, string, string> SetStr = (p, s) => {
  switch (p.propertyType) {
    case UnityEditor.SerializedPropertyType.String: p.stringValue = s; return "";
    case UnityEditor.SerializedPropertyType.Enum: {
      for (var i = 0; i < p.enumNames.Length; i++) if (string.Equals(p.enumNames[i], s, System.StringComparison.OrdinalIgnoreCase) || string.Equals(p.enumDisplayNames[i], s, System.StringComparison.OrdinalIgnoreCase)) { p.enumValueIndex = i; return ""; }
      return p.propertyPath + " has no option " + s + " (options: " + string.Join(", ", p.enumNames) + ")";
    }
    case UnityEditor.SerializedPropertyType.ObjectReference: {
      if (s == "" || s == "None") { p.objectReferenceValue = null; return ""; }
      // The field's type, from Unity's "PPtr<$Type>".
      var want = p.type.StartsWith("PPtr<$") ? p.type.Substring(6, p.type.Length - 7) : "";
      System.Func<System.Type, bool> Fits = t => { for (; t != null; t = t.BaseType) if (t.Name == want) return true; return want == ""; };
      UnityEngine.Object pick = null;
      if (s.StartsWith("Assets/") || s.StartsWith("Packages/")) {
        foreach (var a in UnityEditor.AssetDatabase.LoadAllAssetsAtPath(s)) if (a != null && Fits(a.GetType())) { pick = a; break; }
        if (pick == null && UnityEditor.AssetDatabase.LoadMainAssetAtPath(s) == null) return "there is no asset " + s;
      } else {
        var o = Resolve(s);
        if (o == null) return "no GameObject " + s + " in the open scene";
        if (want == "GameObject" || want == "") pick = o;
        else foreach (var cc in o.GetComponents<UnityEngine.Component>()) if (cc != null && Fits(cc.GetType())) { pick = cc; break; }
      }
      if (pick == null) return s + " has nothing of type " + want + " for " + p.propertyPath;
      p.objectReferenceValue = pick; return p.objectReferenceValue == pick ? "" : s + " does not fit " + p.propertyPath;
    }
    default: return p.propertyPath + " is " + p.propertyType + ", not text";
  }
};`;

/**
 * C# for a change list: every object is found first (one missing changes nothing), the changes run as one Undo group,
 * and each is reported in a line.
 */
export function modifyCs(changes: SceneChange[]): string {
  const keys: string[] = [];
  const indexOf = (k: string) => {
    const i = keys.indexOf(k);
    return i >= 0 ? i : keys.push(k) - 1;
  };
  const blocks = changes.map((c) => {
    const i = indexOf(c.object);
    const pi = c.action === "reparent" && c.value ? indexOf(String(c.value)) : -1;
    return `{ var go = objs[${i}];
  if (go == null) log.AppendLine("skipped (deleted above): " + keys[${i}]);
  else { var name = PathOf(go.transform);
  ${changeCs(c, pi)} } }`;
  });
  return `${SCENE_PRELUDE}
${changes.some((c) => c.action === "set_property") ? SETTERS : ""}
var keys = new string[] { ${keys.map(csString).join(", ")} };
var objs = new UnityEngine.GameObject[keys.Length]; var missing = new System.Collections.Generic.List<string>();
for (var i = 0; i < keys.Length; i++) { objs[i] = Resolve(keys[i]); if (objs[i] == null) missing.Add(keys[i]); }
if (missing.Count > 0) return "Nothing changed: no GameObject " + string.Join(", ", missing) + " in the open scene (see unity_scene hierarchy).";
foreach (var o in objs) UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(o.scene);
UnityEditor.Undo.IncrementCurrentGroup(); var group = UnityEditor.Undo.GetCurrentGroup(); UnityEditor.Undo.SetCurrentGroupName("KesherAI: change the scene");
var log = new System.Text.StringBuilder();
${blocks.join("\n")}
UnityEditor.Undo.CollapseUndoOperations(group);
return log.ToString() + "(one Undo step in Unity; not saved yet: unity_scene save)";`;
}

/** C# that names each key's object ("Level/Door #-12") for the approval card, or "(not found)". */
function namesCs(keys: string[]): string {
  return `${SCENE_PRELUDE}
var sb = new System.Text.StringBuilder();
foreach (var k in new string[] { ${keys.map(csString).join(", ")} }) { var o = Resolve(k); sb.AppendLine(o == null ? "(not found)" : PathOf(o.transform) + " #" + o.GetInstanceID()); }
return sb.ToString();`;
}


/** Where imported pictures go inside the project. */
export const GENERATED = "Assets/Generated";
const MAX_IMAGE = 64 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|tga|psd|tiff?|bmp|exr|hdr|gif)$/i;

/**
 * The picture type from its first bytes (so a file named .png that is not a picture is never copied). TGA has no
 * signature: it is trusted by its name.
 *
 * @returns The file extension Unity imports it by, "webp" (Unity cannot import it), or undefined.
 */
export function sniffImage(data: Uint8Array, name = ""): string | undefined {
  const b = (i: number) => data[i] ?? -1;
  const text = (n: number) => String.fromCharCode(...data.slice(0, n));
  if (b(0) === 0x89 && text(4).slice(1) === "PNG") return "png";
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "jpg";
  if (text(4) === "GIF8") return "gif";
  if (text(2) === "BM") return "bmp";
  if (text(4) === "8BPS") return "psd";
  if (text(4) === "II*\0" || text(4) === "MM\0*") return "tif";
  if (b(0) === 0x76 && b(1) === 0x2f && b(2) === 0x31 && b(3) === 0x01) return "exr";
  if (text(10) === "#?RADIANCE" || text(6) === "#?RGBE") return "hdr";
  if (text(4) === "RIFF" && String.fromCharCode(...data.slice(8, 12)) === "WEBP") return "webp";
  if (/\.tga$/i.test(name) && data.length > 18) return "tga";
  return undefined;
}

/** A file name part from any text: letters, digits, space, _ and -, at most 60 characters. */
export const safeName = (text: string, dflt: string): string => text.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[^\p{L}\p{N} _-]/gu, "_").trim().slice(0, 60) || dflt;

/**
 * Brings a picture into the project: a file already under Assets/ stays where it is; a library picture (its id) or a
 * picture file on this computer (an absolute path) is copied to `folder` as `<name>.<ext>`, never over another file.
 * The copy is recorded for KesherAI's Undo.
 *
 * @param d - The tools' dependencies (project, library reader).
 * @param given - "Assets/…", a library id, or an absolute path.
 * @param folder - Project-relative folder for copies (under Assets/Generated).
 * @param name - The copy's name without extension (default: the source's).
 * @param ctx - The tool call (records the new file).
 * @returns The project-relative path and whether it was copied.
 * @throws Error in plain words when the source is missing, too big or not a picture Unity imports.
 */
export async function bringImage(d: UnityEditDeps, given: string, folder: string, name: string | undefined, ctx: ToolContext): Promise<{ rel: string; copied: boolean }> {
  const project = d.project()!;
  const src = given.trim().replace(/\\/g, "/");
  if (/^Assets\//i.test(src)) {
    const { abs, rel } = projectPath(project, src, ["Assets"]);
    if (!IMAGE_EXT.test(rel)) throw new Error(`${rel} is not a picture Unity imports (png, jpg, tga, psd, tif, bmp, exr, hdr, gif).`);
    if (!(await stat(abs).catch(() => undefined))?.isFile()) throw new Error(`There is no file ${rel} in the project.`);
    return { rel, copied: false };
  }
  let data: Uint8Array;
  let from: string;
  if (/^[0-9a-f-]{36}$/i.test(src)) {
    const asset = await d.readAsset?.(src.toLowerCase());
    if (!asset) throw new Error(`There is no picture ${src} in KesherAI's library.`);
    data = asset.data;
    from = `picture-${src.slice(0, 8)}`;
  } else if (isAbsolute(src) || /^[a-z]:\//i.test(src)) {
    const s = await stat(src).catch(() => undefined);
    if (!s?.isFile()) throw new Error(`There is no file ${src}.`);
    if (s.size > MAX_IMAGE) throw new Error(`${basename(src)} is too big (over 64 MB).`);
    data = await readFile(src);
    from = basename(src);
  } else throw new Error("Give a picture: a path under Assets/, a library picture's id, or the full path of a picture file on this computer.");
  if (data.length > MAX_IMAGE) throw new Error("That picture is too big (over 64 MB).");
  const ext = sniffImage(data, from);
  if (ext === "webp") throw new Error("Unity cannot import WebP pictures: save it as PNG first.");
  if (!ext) throw new Error(`${from} is not a picture Unity imports (png, jpg, tga, psd, tif, bmp, exr, hdr, gif).`);
  const base = safeName(name ?? "", safeName(from, "Picture"));
  let rel = "";
  for (let i = 1; i < 1000; i++) {
    const candidate = `${folder}/${base}${i === 1 ? "" : `-${i}`}.${ext}`;
    if (!existsSync(projectPath(project, candidate, ["Assets"]).abs)) {
      rel = candidate;
      break;
    }
  }
  if (!rel) throw new Error(`Too many pictures named ${base} in ${folder}.`);
  const { abs } = projectPath(project, rel, ["Assets"]);
  await mkdir(dirname(abs), { recursive: true });
  ctx.recordChange(abs, null);
  await writeFile(abs, data);
  return { rel, copied: true };
}

/** C# that makes Unity's asset database know every folder above `pathVar` (a file or folder the tool just wrote). */
const KNOW_FOLDERS = (pathVar: string) => `{ var parts = ${pathVar}.Split('/'); var at = parts[0];
  for (var fi = 1; fi < parts.Length - (${pathVar}.Contains(".") ? 1 : 0); fi++) { at += "/" + parts[fi]; if (!UnityEditor.AssetDatabase.IsValidFolder(at)) { System.IO.Directory.CreateDirectory(at); UnityEditor.AssetDatabase.ImportAsset(at); } } }`;

const FILTERS = { point: "Point", bilinear: "Bilinear", trilinear: "Trilinear" } as const;
const COMPRESSIONS = { none: "Uncompressed", low: "CompressedLQ", normal: "Compressed", high: "CompressedHQ" } as const;

/** Sprite import settings, checked (defaults: 100 pixels per unit, bilinear, normal compression). */
export function spriteOptions(input: Record<string, unknown>): { ppu: number; filter: keyof typeof FILTERS; compression: keyof typeof COMPRESSIONS } {
  const filter = (Object.keys(FILTERS) as Array<keyof typeof FILTERS>).find((k) => k === input.filter) ?? "bilinear";
  const compression = (Object.keys(COMPRESSIONS) as Array<keyof typeof COMPRESSIONS>).find((k) => k === input.compression) ?? "normal";
  return { ppu: clampInt(input.pixels_per_unit, 1, 10_000, 100), filter, compression };
}

/** C# that imports a picture of the project as a single sprite with these settings. */
export function importSpriteCs(rel: string, o: ReturnType<typeof spriteOptions>): string {
  return `var path = ${csString(rel)};
${KNOW_FOLDERS("path")}
UnityEditor.AssetDatabase.ImportAsset(path, UnityEditor.ImportAssetOptions.ForceSynchronousImport);
var ti = UnityEditor.AssetImporter.GetAtPath(path) as UnityEditor.TextureImporter;
if (ti == null) return "Unity did not import " + path + " as a picture.";
ti.textureType = UnityEditor.TextureImporterType.Sprite;
ti.spriteImportMode = UnityEditor.SpriteImportMode.Single;
ti.spritePixelsPerUnit = ${o.ppu};
ti.filterMode = UnityEngine.FilterMode.${FILTERS[o.filter]};
ti.textureCompression = UnityEditor.TextureImporterCompression.${COMPRESSIONS[o.compression]};
ti.alphaIsTransparency = true;
ti.mipmapEnabled = false;
int w, h; ti.GetSourceTextureWidthAndHeight(out w, out h);
// Keep the full size (Unity's default limit is 2048).
var size = 32; while (size < System.Math.Max(w, h) && size < 16384) size *= 2;
ti.maxTextureSize = size;
ti.SaveAndReimport();
var sp = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.Sprite>(path);
if (sp == null) return "Imported " + path + ", but Unity made no sprite from it.";
return "Imported " + path + " as a sprite: " + w + "x" + h + " px, ${o.ppu} pixels per unit (" + (w / ${o.ppu}f) + " x " + (h / ${o.ppu}f) + " units), ${o.filter} filter, ${o.compression} compression. Use it with a SpriteRenderer (unity_modify_scene set_property SpriteRenderer m_Sprite = this path).";`;
}

/** The texture slots of `unity_create_pbr_material`. */
export const PBR_MAPS = ["albedo", "normal", "metallic", "roughness", "smoothness", "ao"] as const;
/** Project paths of a material's maps, by slot. */
export type PbrMaps = Partial<Record<(typeof PBR_MAPS)[number], string>>;

/**
 * C# that makes a PBR material for the project's render pipeline (URP Lit, HDRP Lit or Built-in Standard), saves it
 * next to its textures and, if asked, puts it on objects' renderers (children too) as one Undo step.
 *
 * Grayscale maps are packed the way each shader reads them: URP and Built-in take metallic in R and smoothness in A
 * of one "metallic gloss" map, HDRP a "mask map" (R metallic, G occlusion, A smoothness). Roughness becomes
 * smoothness (1 - roughness). The normal map's import is set to Normal map; grayscale maps are imported as linear.
 *
 * @param o.name - The material's name; `o.folder` the project folder for it and the packed map.
 * @param o.maps - Project paths of the maps (already in the project).
 * @param o.apply - Objects (#id or path) to put it on; `o.selection` adds the Editor's selected objects.
 */
export function pbrCs(o: { name: string; folder: string; maps: PbrMaps; apply: string[]; selection: boolean }): string {
  const m = (k: keyof PbrMaps) => csString(o.maps[k] ?? "");
  return `${SCENE_PRELUDE}
var rp = UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline;
var rpName = rp == null ? "" : rp.GetType().Name;
var kind = rp == null ? "builtin" : rpName.Contains("HDRenderPipeline") ? "hdrp" : rpName.Contains("Universal") ? "urp" : "";
if (kind == "") return "This project uses its own render pipeline (" + rpName + "), so no standard Lit shader fits: make the material with unity_script_eval for its shaders.";
var shaderName = kind == "urp" ? "Universal Render Pipeline/Lit" : kind == "hdrp" ? "HDRP/Lit" : "Standard";
var shader = UnityEngine.Shader.Find(shaderName);
if (shader == null) return "The shader " + shaderName + " is not in this project; nothing was made.";
var name = ${csString(o.name)}; var folder = ${csString(o.folder)};
${KNOW_FOLDERS("folder")}
var log = new System.Text.StringBuilder();
// Import settings first: a normal map as Normal map, grayscale maps linear, color maps sRGB.
System.Func<string, int, UnityEngine.Texture2D> Tex = (path, use) => {
  if (path == "") return null;
  UnityEditor.AssetDatabase.ImportAsset(path, UnityEditor.ImportAssetOptions.ForceSynchronousImport);
  var ti = UnityEditor.AssetImporter.GetAtPath(path) as UnityEditor.TextureImporter;
  if (ti != null) {
    var changed = false;
    if (use == 1 && ti.textureType != UnityEditor.TextureImporterType.NormalMap) { ti.textureType = UnityEditor.TextureImporterType.NormalMap; changed = true; }
    if (use != 1 && ti.textureType != UnityEditor.TextureImporterType.Default) { ti.textureType = UnityEditor.TextureImporterType.Default; changed = true; }
    if (use != 1 && ti.sRGBTexture != (use == 0)) { ti.sRGBTexture = use == 0; changed = true; }
    if (changed) ti.SaveAndReimport();
  }
  var t = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.Texture2D>(path);
  if (t == null) log.AppendLine("skipped " + path + ": Unity did not load it as a texture");
  return t;
};
var albedo = Tex(${m("albedo")}, 0); var normal = Tex(${m("normal")}, 1);
var metal = Tex(${m("metallic")}, 2); var rough = Tex(${m("roughness")}, 2); var smooth = Tex(${m("smoothness")}, 2); var ao = Tex(${m("ao")}, 2);
// Any texture's pixels, through the GPU (works for compressed and non-readable textures).
System.Func<UnityEngine.Texture2D, int, int, UnityEngine.Color32[]> Pixels = (src, w, h) => {
  var rt = UnityEngine.RenderTexture.GetTemporary(w, h, 0, UnityEngine.RenderTextureFormat.ARGB32, UnityEngine.RenderTextureReadWrite.Linear);
  UnityEngine.Graphics.Blit(src, rt);
  var prev = UnityEngine.RenderTexture.active; UnityEngine.RenderTexture.active = rt;
  var tmp = new UnityEngine.Texture2D(w, h, UnityEngine.TextureFormat.RGBA32, false, true);
  tmp.ReadPixels(new UnityEngine.Rect(0, 0, w, h), 0, 0); tmp.Apply();
  UnityEngine.RenderTexture.active = prev; UnityEngine.RenderTexture.ReleaseTemporary(rt);
  var px = tmp.GetPixels32(); UnityEngine.Object.DestroyImmediate(tmp); return px;
};
UnityEngine.Texture2D packed = null;
var gloss = smooth ?? rough;
if (metal != null || gloss != null || (kind == "hdrp" && ao != null)) {
  int w = 0, h = 0;
  foreach (var t in new[] { metal, gloss, kind == "hdrp" ? ao : null }) if (t != null) { w = System.Math.Max(w, t.width); h = System.Math.Max(h, t.height); }
  w = System.Math.Min(w, 4096); h = System.Math.Min(h, 4096);
  var mp = metal != null ? Pixels(metal, w, h) : null; var gp = gloss != null ? Pixels(gloss, w, h) : null; var ap = kind == "hdrp" && ao != null ? Pixels(ao, w, h) : null;
  var outPx = new UnityEngine.Color32[w * h];
  for (var i = 0; i < outPx.Length; i++) {
    byte mv = mp != null ? mp[i].r : (byte)0;
    byte sv = gp != null ? (smooth != null ? gp[i].r : (byte)(255 - gp[i].r)) : (byte)128;
    byte av = ap != null ? ap[i].r : (byte)255;
    outPx[i] = kind == "hdrp" ? new UnityEngine.Color32(mv, av, 0, sv) : new UnityEngine.Color32(mv, mv, mv, sv);
  }
  var pt = new UnityEngine.Texture2D(w, h, UnityEngine.TextureFormat.RGBA32, true, true); pt.SetPixels32(outPx); pt.Apply();
  var packedPath = UnityEditor.AssetDatabase.GenerateUniqueAssetPath(folder + "/" + name + (kind == "hdrp" ? "_MaskMap.png" : "_MetallicSmoothness.png"));
  System.IO.File.WriteAllBytes(packedPath, pt.EncodeToPNG()); UnityEngine.Object.DestroyImmediate(pt);
  UnityEditor.AssetDatabase.ImportAsset(packedPath, UnityEditor.ImportAssetOptions.ForceSynchronousImport);
  var pi = UnityEditor.AssetImporter.GetAtPath(packedPath) as UnityEditor.TextureImporter;
  if (pi != null) { pi.sRGBTexture = false; pi.alphaSource = UnityEditor.TextureImporterAlphaSource.FromInput; pi.alphaIsTransparency = false; pi.SaveAndReimport(); }
  packed = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.Texture2D>(packedPath);
  log.AppendLine("packed " + (kind == "hdrp" ? "mask map" : "metallic/smoothness map") + ": " + packedPath);
}
var mat = new UnityEngine.Material(shader); mat.name = name;
if (kind == "urp") {
  if (albedo != null) mat.SetTexture("_BaseMap", albedo);
  if (normal != null) { mat.SetTexture("_BumpMap", normal); mat.EnableKeyword("_NORMALMAP"); }
  if (packed != null) { mat.SetTexture("_MetallicGlossMap", packed); mat.EnableKeyword("_METALLICSPECGLOSSMAP"); mat.SetFloat("_Smoothness", 1f); }
  if (ao != null) { mat.SetTexture("_OcclusionMap", ao); mat.EnableKeyword("_OCCLUSIONMAP"); }
} else if (kind == "hdrp") {
  if (albedo != null) mat.SetTexture("_BaseColorMap", albedo);
  if (normal != null) { mat.SetTexture("_NormalMap", normal); mat.EnableKeyword("_NORMALMAP"); mat.EnableKeyword("_NORMALMAP_TANGENT_SPACE"); }
  if (packed != null) { mat.SetTexture("_MaskMap", packed); mat.EnableKeyword("_MASKMAP"); mat.SetFloat("_MetallicRemapMax", 1f); mat.SetFloat("_SmoothnessRemapMax", 1f); mat.SetFloat("_AORemapMax", 1f); }
  // HDRP's own keyword reset, when its editor code is here (it is internal in some versions).
  foreach (var asm in System.AppDomain.CurrentDomain.GetAssemblies()) {
    var hu = asm.GetType("UnityEditor.Rendering.HighDefinition.HDShaderUtils");
    var reset = hu == null ? null : hu.GetMethod("ResetMaterialKeywords", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic, null, new[] { typeof(UnityEngine.Material) }, null);
    if (reset != null) { try { reset.Invoke(null, new object[] { mat }); } catch (System.Exception) { } break; }
  }
} else {
  if (albedo != null) mat.SetTexture("_MainTex", albedo);
  if (normal != null) { mat.SetTexture("_BumpMap", normal); mat.EnableKeyword("_NORMALMAP"); }
  if (packed != null) { mat.SetTexture("_MetallicGlossMap", packed); mat.EnableKeyword("_METALLICGLOSSMAP"); mat.SetFloat("_GlossMapScale", 1f); }
  if (ao != null) mat.SetTexture("_OcclusionMap", ao);
}
var matPath = UnityEditor.AssetDatabase.GenerateUniqueAssetPath(folder + "/" + name + ".mat");
UnityEditor.AssetDatabase.CreateAsset(mat, matPath);
UnityEditor.AssetDatabase.SaveAssets();
log.Insert(0, "Made " + matPath + " (" + shaderName + ", " + (kind == "builtin" ? "Built-in" : kind.ToUpperInvariant()) + " pipeline)\\n");
var targets = new System.Collections.Generic.List<UnityEngine.GameObject>();
foreach (var k in new string[] { ${o.apply.map(csString).join(", ")} }) { var g = Resolve(k); if (g == null) log.AppendLine("not put on " + k + ": no such GameObject in the open scene"); else targets.Add(g); }
${o.selection ? "foreach (var g in UnityEditor.Selection.gameObjects) if (g.scene.IsValid() && !targets.Contains(g)) targets.Add(g);" : ""}
if (targets.Count > 0) {
  UnityEditor.Undo.IncrementCurrentGroup(); var group = UnityEditor.Undo.GetCurrentGroup(); UnityEditor.Undo.SetCurrentGroupName("KesherAI: material " + name);
  var count = 0;
  foreach (var g in targets) {
    foreach (var r in g.GetComponentsInChildren<UnityEngine.Renderer>(true)) {
      UnityEditor.Undo.RecordObject(r, "KesherAI: material");
      var mats = r.sharedMaterials;
      if (mats.Length == 0) r.sharedMaterial = mat; else { for (var i = 0; i < mats.Length; i++) mats[i] = mat; r.sharedMaterials = mats; }
      count++;
    }
    UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(g.scene);
    log.AppendLine("put on " + PathOf(g.transform));
  }
  UnityEditor.Undo.CollapseUndoOperations(group);
  log.AppendLine(count + " renderers changed (one Undo step; not saved yet: unity_scene save)" + (count == 0 ? ": none of these objects has a renderer" : ""));
}
return log.ToString();`;
}

/**
 * The Unity scene tools that work on single objects.
 *
 * @param d - The project, the "no project" check and C# in the open Editor (from `unityTools`).
 * @returns `unity_inspect_object`, `unity_modify_scene`, `unity_import_sprite` and `unity_create_pbr_material`.
 */
export function unityEditTools(d: UnityEditDeps): AgentTool[] {
  return [
    {
      risk: "read",
      spec: {
        name: "unity_inspect_object",
        description: "One GameObject of the open scene in detail: its transform, components and their serialized fields (property path = value, the paths unity_modify_scene set_property takes). Find the object first with unity_scene hierarchy (its #id) or give its path like 'Level/Door'.",
        inputSchema: {
          type: "object",
          properties: {
            object: { type: "string", description: "The #id from the hierarchy (e.g. '#-1234') or the path ('Level/Door')." },
            component: { type: "string", description: "Only this component (its type name, e.g. 'Rigidbody' or a script's class), with more of its fields." },
            limit: { type: "number", description: "Fields per component: default 25 (100 with component), at most 300." },
          },
          required: ["object"],
        },
      },
      run: async (input) => {
        d.need();
        const key = String(input.object ?? "").trim().slice(0, 300);
        if (!key) return { output: "Give the object's #id (from unity_scene hierarchy) or its path." };
        const component = String(input.component ?? "").trim();
        if (component && !/^[A-Za-z_][A-Za-z0-9_.]{0,120}$/.test(component)) return { output: `"${component}" is not a component type name.` };
        const limit = clampInt(input.limit, 1, 300, component ? 100 : 25);
        return { output: await d.evalCs(inspectCs(key, component, limit)) };
      },
    },
    {
      risk: "write",
      spec: {
        name: "unity_modify_scene",
        description: "Change objects of the open scene, all in one Unity Undo step: move, rotate, scale (value [x, y, z]; space 'world' for move/rotate, else local), rename (value: name), reparent (value: new parent #id or path, '' for the top), delete, set_active (value true/false), set_property (component type name or 'GameObject', property path from unity_inspect_object, value: number, true/false, text for an enum name / asset path / object #id, or 2-4 numbers for a vector or color). Objects by #id (from unity_scene hierarchy) or path. Deleting, or changing several objects, asks the user first. Save after with unity_scene save.",
        inputSchema: {
          type: "object",
          properties: {
            changes: {
              type: "array",
              description: `Up to ${MAX_CHANGES} changes, done in order.`,
              items: {
                type: "object",
                properties: {
                  object: { type: "string", description: "#id or path." },
                  action: { type: "string", enum: [...SCENE_ACTIONS] },
                  value: { description: "See the tool's description for each action." },
                  space: { type: "string", enum: ["local", "world"] },
                  component: { type: "string", description: "set_property only." },
                  property: { type: "string", description: "set_property only, e.g. m_Mass." },
                },
                required: ["object", "action"],
              },
            },
          },
          required: ["changes"],
        },
      },
      askFirst: (input) => {
        const changes = parseSceneChanges(input.changes);
        if (typeof changes === "string") return undefined;
        const { objects, deletes } = sceneReach(changes);
        return sceneAskReason(objects, deletes);
      },
      preview: async (input) => {
        const changes = parseSceneChanges(input.changes);
        if (typeof changes === "string") return changes;
        // The real names of #ids, when the Editor answers (else the card shows what the model gave).
        const keys = [...new Set(changes.map((c) => c.object))];
        const named = d.project() ? (await d.evalCs(namesCs(keys)).catch(() => "")).split("\n").map((l) => l.trim()) : [];
        const label = (k: string) => {
          const n = named[keys.indexOf(k)];
          return n && n.includes("#") && named.length >= keys.length ? n : k;
        };
        const { objects, deletes } = sceneReach(changes);
        const lines = changes.map((c, i) => `${i + 1}. ${label(c.object)}: ${describeSceneChange(c)}`);
        return `Unity scene: ${objects} object${objects === 1 ? "" : "s"}${deletes ? `, ${deletes} deleted` : ""} (one Undo step)\n${lines.join("\n")}`;
      },
      run: async (input) => {
        d.need();
        const changes = parseSceneChanges(input.changes);
        if (typeof changes === "string") return { output: changes };
        return { output: await d.evalCs(modifyCs(changes)) };
      },
    },
    {
      risk: "write",
      spec: {
        name: "unity_import_sprite",
        description: `Put a picture into the Unity project as a 2D sprite: a library picture (its id, e.g. one you generated), a picture file on this computer (full path) or one already under Assets/. A copy goes to ${GENERATED}/; the import is set to Sprite (single), pixels per unit, filter and compression. Pixel art: filter point, compression none. Returns the sprite's asset path.`,
        inputSchema: {
          type: "object",
          properties: {
            file: { type: "string", description: "Library picture id, full path on this computer, or Assets/… path." },
            name: { type: "string", description: "The copy's file name (default: the source's)." },
            pixels_per_unit: { type: "number", description: "Default 100: a 100 px wide picture is 1 unit wide." },
            filter: { type: "string", enum: Object.keys(FILTERS) },
            compression: { type: "string", enum: Object.keys(COMPRESSIONS) },
          },
          required: ["file"],
        },
      },
      preview: async (input) => {
        const o = spriteOptions(input);
        const file = String(input.file ?? "");
        const where = /^Assets\//i.test(file.replace(/\\/g, "/")) ? file : `${GENERATED}/${input.name ? safeName(String(input.name), "Picture") : extname(file) ? basename(file) : "…"}`;
        return `Import a sprite into ${d.project() ?? "(no project)"}\nfrom: ${file}\nto: ${where}\nSprite (single), ${o.ppu} pixels per unit, ${o.filter} filter, ${o.compression} compression`;
      },
      run: async (input, ctx) => {
        d.need();
        const o = spriteOptions(input);
        let brought: { rel: string; copied: boolean };
        try {
          brought = await bringImage(d, String(input.file ?? ""), GENERATED, input.name ? String(input.name) : undefined, ctx);
        } catch (e) {
          return { output: (e as Error).message };
        }
        const head = brought.copied ? `Copied the picture to ${brought.rel}.` : "";
        const said = await d.evalCs(importSpriteCs(brought.rel, o));
        const failed = /^(Unity did not run it|C# failed)/.test(said);
        return { output: `${head}${head ? "\n" : ""}${failed ? `${said}\nThe file is in the project; run unity_import_sprite again on ${brought.rel} once the Editor is ready (unity_status).` : said}` };
      },
    },
    {
      risk: "write",
      spec: {
        name: "unity_create_pbr_material",
        description: `Make a PBR material for the project's render pipeline (URP Lit, HDRP Lit or Built-in Standard, found by itself) from texture maps, and optionally put it on objects (one Undo step). Each map is a library picture id, a full path on this computer or an Assets/ path; copies go to ${GENERATED}/<name>/. Give roughness OR smoothness; metallic, roughness/smoothness (and AO in HDRP) are packed into the map the shader reads. The normal map is imported as a Normal map.`,
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The material's name, e.g. 'Rusty Metal'." },
            maps: {
              type: "object",
              properties: Object.fromEntries(PBR_MAPS.map((k) => [k, { type: "string" }])),
              description: "albedo (base color), normal, metallic, roughness or smoothness, ao (ambient occlusion); at least one.",
            },
            apply_to: { type: "array", items: { type: "string" }, description: "Objects (#id or path) to put it on, or 'selection' for the objects selected in Unity." },
          },
          required: ["name", "maps"],
        },
      },
      askFirst: (input) => {
        const list = Array.isArray(input.apply_to) ? input.apply_to.map(String) : [];
        if (list.includes("selection")) return "Changes the selected objects in the Unity scene.";
        return sceneAskReason(new Set(list).size, 0);
      },
      preview: async (input) => {
        const maps = (input.maps ?? {}) as Record<string, unknown>;
        const name = safeName(String(input.name ?? ""), "Material");
        const lines = PBR_MAPS.filter((k) => maps[k]).map((k) => `  ${k}: ${String(maps[k])}`);
        const list = Array.isArray(input.apply_to) ? input.apply_to.map(String) : [];
        return `Make the material ${GENERATED}/${name}/${name}.mat in ${d.project() ?? "(no project)"}\n${lines.join("\n")}${list.length ? `\nPut it on: ${list.join(", ")} (one Undo step)` : ""}`;
      },
      run: async (input, ctx) => {
        d.need();
        const name = safeName(String(input.name ?? ""), "Material");
        const given = (input.maps && typeof input.maps === "object" ? input.maps : {}) as Record<string, unknown>;
        const unknown = Object.keys(given).filter((k) => !(PBR_MAPS as readonly string[]).includes(k));
        if (unknown.length) return { output: `Unknown map ${unknown.join(", ")}: use ${PBR_MAPS.join(", ")}.` };
        if (given.roughness && given.smoothness) return { output: "Give roughness OR smoothness, not both." };
        const list = input.apply_to === undefined ? [] : Array.isArray(input.apply_to) ? input.apply_to.map((x) => String(x).trim()).filter(Boolean) : null;
        if (!list || list.length > 50 || list.some((k) => k.length > 300)) return { output: "apply_to is a list of up to 50 objects (#id or path), or 'selection'." };
        const folder = `${GENERATED}/${name}`;
        const maps: PbrMaps = {};
        const copied: string[] = [];
        for (const k of PBR_MAPS) {
          if (!given[k]) continue;
          try {
            const b = await bringImage(d, String(given[k]), folder, `${name}_${k}`, ctx);
            maps[k] = b.rel;
            if (b.copied) copied.push(b.rel);
          } catch (e) {
            return { output: `${k}: ${(e as Error).message}${copied.length ? ` (already copied: ${copied.join(", ")})` : ""}` };
          }
        }
        if (!Object.keys(maps).length) return { output: `Give at least one map: ${PBR_MAPS.join(", ")}.` };
        const said = await d.evalCs(pbrCs({ name, folder, maps, apply: list.filter((k) => k !== "selection"), selection: list.includes("selection") }));
        return { output: `${copied.length ? `Copied ${copied.join(", ")}.\n` : ""}${said}` };
      },
    },
  ];
}
