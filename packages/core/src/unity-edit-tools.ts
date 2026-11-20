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

/**
 * The Unity scene tools that work on single objects.
 *
 * @param d - The project, the "no project" check and C# in the open Editor (from `unityTools`).
 * @returns `unity_inspect_object` (more come with the next steps of Batch 2).
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
  ];
}
