import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";
import { VariablesPanel, type PanelType, type PanelVar } from "../VariablesPanel";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** A Blueprint variable as the plugin reads it (ptype…category: plugin 0.1.9+). */
export interface BpVar { name: string; type: string; ptype?: string; default?: string; editable?: boolean; tooltip?: string; category?: string; private?: boolean }

/** Types a Blueprint variable can have, as the plugin names them; the project's Blueprints are added. */
const UNREAL_TYPES: PanelType[] = [
  { value: "bool", label: "Boolean", input: "bool", group: L("בסיסי", "Basic") },
  { value: "int", label: "Integer", input: "number", group: L("בסיסי", "Basic") },
  { value: "real", label: "Float", input: "number", group: L("בסיסי", "Basic") },
  { value: "string", label: "String", input: "text", group: L("בסיסי", "Basic") },
  { value: "name", label: "Name", input: "text", group: L("בסיסי", "Basic") },
  { value: "text", label: "Text", input: "text", group: L("בסיסי", "Basic") },
  ...["Vector", "Rotator", "Transform", "LinearColor"].map((t): PanelType => ({ value: `struct:${t}`, label: t, input: "code", group: L("מבנים", "Structures") })),
  ...["Actor", "Pawn", "Character", "PlayerController", "StaticMeshComponent", "SceneComponent", "SoundBase", "Texture2D", "MaterialInterface", "UserWidget"].map((t): PanelType => ({ value: `object:${t}`, label: `${t} (Object Reference)`, input: "none", group: L("אובייקטים", "Objects") })),
  { value: "class:Actor", label: "Actor (Class Reference)", input: "none", group: L("אובייקטים", "Objects") },
];

/** Types of a Visual Scripting graph variable (the bridge finds the project's own classes by name too). */
const UNITY_GRAPH_TYPES: PanelType[] = [
  { value: "bool", label: "Boolean", input: "bool", group: L("בסיסי", "Basic") },
  { value: "int", label: "Integer", input: "number", group: L("בסיסי", "Basic") },
  { value: "float", label: "Float", input: "number", group: L("בסיסי", "Basic") },
  { value: "string", label: "String", input: "text", group: L("בסיסי", "Basic") },
  ...["Vector2", "Vector3", "Color"].map((t): PanelType => ({ value: t, label: t, input: "code", group: "Unity" })),
  ...["GameObject", "Transform", "Rigidbody", "Rigidbody2D", "Collider", "Animator", "AudioSource", "AudioClip", "Sprite", "Material", "Camera"].map((t): PanelType => ({ value: t, label: t, input: "none", group: "Unity" })),
];

/** A starting value as Unreal reads it, from the plain text the panel shows. */
const toUnreal = (type: string, v: string) => (type === "bool" ? (v === "true" ? "true" : v ? "false" : "") : v.trim());
/** Unreal's default text to plain (True → true, "" quoted strings → text). */
const fromUnreal = (type: string, v = "") => (type === "bool" ? (/^true$/i.test(v) ? "true" : "false") : type === "string" || type === "name" ? v.replace(/^"(.*)"$/, "$1") : type === "real" ? v.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") : v);

/**
 * The open Blueprint's variables (like My Blueprint → Variables in Unreal):
 * add, rename (its Get/Set nodes follow), change type, starting value,
 * Instance Editable (the eye), tooltip and category, remove. Changes are made in
 * the running editor as one undo step; the graph is read again after each.
 */
export function BlueprintVariables(p: { base: string; path: string; vars: BpVar[]; blueprints: Array<{ path: string; name: string }>; connected: boolean; onGraph: (graph: unknown) => void; unity?: boolean }) {
  const old = p.vars.length > 0 && p.vars.every((v) => v.ptype === undefined);
  const vars: PanelVar[] = p.vars.map((v) => {
    const t = v.ptype ?? v.type;
    return { name: v.name, type: t, value: p.unity ? (v.default ?? "") : fromUnreal(t, v.default), shown: v.editable ?? false, ...(v.tooltip ? { tooltip: v.tooltip } : {}), ...(v.category && v.category !== "Default" ? { category: v.category } : {}), ...(p.unity ? {} : { access: v.private ? "private" : "public" }), ...(old ? { locked: true } : {}) };
  });
  const types: PanelType[] = p.unity ? UNITY_GRAPH_TYPES : [
    ...UNREAL_TYPES,
    ...p.blueprints.filter((b) => b.path !== p.path).map((b): PanelType => ({ value: `object:${b.path}`, label: b.name, input: "none", group: L("ה-Blueprints של הפרויקט", "This project's Blueprints") })),
  ];
  const send = async (ops: unknown[]) => {
    if (!p.connected && !p.unity) throw new Error(L("פתחו את הפרויקט ב-Unreal כדי לשנות משתנים.", "Open the project in Unreal to change variables."));
    const r = await api<{ failed: number; results: Array<{ ok: boolean; error?: string }>; graph?: unknown }>(`${p.base}/vars`, { method: "POST", body: { path: p.path, ops } });
    if (r.graph) p.onGraph(r.graph);
    if (r.failed) throw new Error(r.results.filter((x) => !x.ok).map((x) => x.error).join(" · "));
  };
  const fields = (v: PanelVar) => (p.unity ? { type: v.type, default: v.value.trim() } : { type: v.type, default: toUnreal(v.type, v.value), editable: v.shown, tooltip: v.tooltip ?? "", category: v.category ?? "", private: v.access === "private" });
  return (
    <>
      {old && <p className="muted small">{p.unity ? L("כדי לשנות משתנים מכאן צריך את חבילת KesherAI ל-Unity 0.2.2: עדכנו אותה מהעמוד הזה.", "Changing variables here needs the KesherAI Unity package 0.2.2: update it from this page.") : L("כדי לשנות משתנים מכאן צריך את התוסף 0.1.9: \"עדכון אוטומטי\" בראש העמוד.", "Changing variables here needs plugin 0.1.9: \"Update automatically\" at the top of the page.")}</p>}
      <VariablesPanel
        vars={vars}
        types={types}
        categories={!p.unity}
        listValues={false}
        draggable={!p.unity}
        {...(p.unity ? {} : { access: [{ value: "public", label: L("Public: Blueprints אחרים יכולים לקרוא ולשנות", "Public: other Blueprints can read and change it") }, { value: "private", label: L("Private: רק ה-Blueprint הזה", "Private: this Blueprint only") }] })}
        {...(p.unity ? {} : { shownLabel: L("Instance Editable (משתנה בכל עותק בשלב)", "Instance Editable") })}
        actions={{
          add: (v) => send([{ op: "add", name: v.name, ...fields(v) }]),
          change: (name, v) => send([{ op: "change", name, ...(v.name !== name ? { newName: v.name } : {}), ...fields(v) }]),
          remove: (name) => send([{ op: "remove", name }]).catch((e: Error) => { toast(e.message); throw e; }),
        }}
      />
    </>
  );
}
