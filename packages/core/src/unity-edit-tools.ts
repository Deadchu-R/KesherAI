import type { AgentTool } from "@kesher/agent";
import { csString } from "./unity-tools.js";

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

/**
 * The Unity scene tools that work on single objects.
 *
 * @param d - The project, the "no project" check and C# in the open Editor (from `unityTools`).
 * @returns `unity_inspect_object` and `unity_modify_scene`.
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
  ];
}
