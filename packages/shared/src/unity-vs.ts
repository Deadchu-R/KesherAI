/**
 * Unity Visual Scripting graphs (Script Graph / State Graph) as plain data, so the Visual Scripting page can edit a
 * graph with Unity closed: the saved copy (the JSON the KesherAI Unity package's `kesher_graph` answers) is changed
 * here with the same operations the package applies (`kesher_apply`), and the queued operations show at once.
 * When Unity opens, the queue syncs and Unity's own answer replaces this copy.
 *
 * - {@link applyVsOps}: add, delete, move, connect (with Unity's type rules), disconnect, set a value, groups.
 * - {@link unityPortsFit}: whether a wire from one port type fits another, as Unity tells it.
 * - {@link searchUnits} / {@link COMMON_UNITS}: the node palette (Unity's own list when it was read, else common units).
 * - {@link diffVsGraphs}: what Unity changed compared with the saved copy ("sync on open").
 * - {@link parseVsDoc} / {@link serializeVsDoc}: a checked, stable JSON form (round-trips).
 * - {@link noteLines}: a sticky note's text cut into the lines its frame shows.
 */

/** One port of a unit: `exec` for control ports, else the value type's name as Unity gives it (Single, Int32, …). */
export interface VsPin { name: string; label?: string; dir: "in" | "out"; type: string; default?: string; links?: string[] }

/** One element of a graph: a unit, a state, or a group / sticky note (class GraphGroup / StickyNote, no pins). */
export interface VsNode {
  id: string;
  title: string;
  class: string;
  x: number;
  y: number;
  pins: VsPin[];
  comment?: string;
  /** Groups and sticky notes: their size. */
  width?: number;
  height?: number;
  /** Groups: RRGGBB(AA). */
  color?: string;
  /** Sticky notes: the text under the title; groups: their comment. */
  body?: string;
  /** Member units (Invoke Member, Get / Set Member): Type.FullName:member. */
  function?: string;
  variable?: string;
}

/** One tab of a graph: the flow graph, the states, or a state's / transition's embedded flow graph. */
export interface VsGraph { name: string; kind: "event" | "function" | "macro"; nodes: VsNode[] }

/** A graph variable, as the variables panel shows it. */
export interface VsVariable { name: string; type: string; ptype?: string; default?: string; editable?: boolean; tooltip?: string; category?: string; private?: boolean }

/** A whole graph asset or embedded machine, as `kesher_graph` answers it. */
export interface VsDoc { path: string; name: string; parent?: string; variables: VsVariable[]; graphs: VsGraph[] }

/** One operation (the same vocabulary as the package's `kesher_apply`). */
export type VsOp = Record<string, unknown>;

/** The answer for one operation. */
export interface VsResult { op: string; ok: boolean; error?: string; node?: string }

/** One entry of the node palette (the shape of the package's `kesher_actions`). */
export interface VsUnit { title: string; category: string; type: string; function?: string; event?: string; variable?: string; name?: string }

/** Classes drawn as frames around nodes instead of nodes. */
export const VS_NOTE_CLASSES = ["GraphGroup", "StickyNote"] as const;

/** @returns Whether the element is a group or a sticky note. */
export function isVsNote(n: Pick<VsNode, "class">): boolean {
  return (VS_NOTE_CLASSES as readonly string[]).includes(n.class);
}

/**
 * A sticky note's text cut into the lines that fit its frame (SVG text does not wrap by itself).
 *
 * @param body - The text.
 * @param w - The frame's width (graph units).
 * @param h - The frame's height.
 * @returns The lines to draw; the last one ends with "…" when the text is longer.
 */
export function noteLines(body: string, w: number, h: number): string[] {
  const per = Math.max(8, Math.floor((w - 16) / 7));
  const max = Math.max(1, Math.floor((h - 34) / 16));
  const out: string[] = [];
  for (const para of body.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (line && (line + " " + word).length > per) {
        out.push(line);
        line = "";
      }
      line = line ? `${line} ${word}` : word.slice(0, per);
    }
    out.push(line);
  }
  if (out.length > max) return [...out.slice(0, max - 1), `${out[max - 1]!.slice(0, per - 1)}…`];
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Type rules
// ---------------------------------------------------------------------------------------------------------------

const NUMBERS = new Set(["Single", "Double", "Int32", "Int64", "Int16", "UInt16", "UInt32", "UInt64", "Byte", "SByte", "Decimal", "float", "int", "double"]);
const VECTORS = new Set(["Vector2", "Vector3", "Vector4"]);
/** Unity objects the Visual Scripting conversions move between (a GameObject gives its components and back). */
const UNITY_OBJECTS = new Set([
  "GameObject", "Component", "Transform", "RectTransform", "MonoBehaviour", "Behaviour", "Rigidbody", "Rigidbody2D", "Collider", "Collider2D",
  "BoxCollider", "SphereCollider", "CapsuleCollider", "MeshCollider", "BoxCollider2D", "CircleCollider2D", "Animator", "AudioSource", "Camera",
  "Light", "Renderer", "MeshRenderer", "SpriteRenderer", "SkinnedMeshRenderer", "CharacterController", "NavMeshAgent", "ParticleSystem",
  "Canvas", "Image", "Text", "Button", "TextMeshProUGUI", "ScriptMachine", "StateMachine", "Variables",
]);
const LISTS = /(\[\]|List`1|IEnumerable|IList|ICollection|AotList)$/;

/**
 * Whether a wire from an output port of one type fits an input port of another, by Unity's own rules
 * (`CanValidlyConnectTo`: guaranteed and checked-at-run-time conversions): control to control; any value into an
 * `object` input; the same type; numbers to numbers; vectors to vectors; GameObject and its components; lists into
 * enumerables; an `object` output into any input (checked when it runs).
 *
 * @param from - The output port's type.
 * @param to - The input port's type.
 * @returns ok, and in short why (a conversion's direction, or why it does not fit).
 */
export function unityPortsFit(from: string, to: string): { ok: boolean; why: string } {
  if ((from === "exec") !== (to === "exec")) return { ok: false, why: "Control ≠ value" };
  if (from === to || to === "object" || to === "Object" && UNITY_OBJECTS.has(from)) return { ok: true, why: "" };
  if (NUMBERS.has(from) && NUMBERS.has(to)) return { ok: true, why: `${from} → ${to}` };
  if (VECTORS.has(from) && VECTORS.has(to)) return { ok: true, why: `${from} → ${to}` };
  if (UNITY_OBJECTS.has(from) && UNITY_OBJECTS.has(to)) return { ok: true, why: `${from} → ${to}` };
  if (LISTS.test(from) && /IEnumerable|IList|ICollection/.test(to)) return { ok: true, why: "" };
  if (from === "object") return { ok: true, why: `object → ${to}` };
  return { ok: false, why: `${from} ≠ ${to}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Common units (the palette with Unity never read, and the ports of units added with Unity closed)
// ---------------------------------------------------------------------------------------------------------------

type PinT = [name: string, dir: "in" | "out", type: string, def?: string];
interface UnitTemplate { unit: VsUnit; pins: PinT[] }

const ENTER: PinT = ["enter", "in", "exec"];
const EXIT: PinT = ["exit", "out", "exec"];
const TRIGGER: PinT = ["trigger", "out", "exec"];

/** Common Visual Scripting units with their ports as Unity names them (the type is the unit's class name). */
const TEMPLATES: UnitTemplate[] = [
  { unit: { title: "On Start", category: "Events/Lifecycle", type: "Start" }, pins: [TRIGGER] },
  { unit: { title: "On Update", category: "Events/Lifecycle", type: "Update" }, pins: [TRIGGER] },
  { unit: { title: "On Fixed Update", category: "Events/Lifecycle", type: "FixedUpdate" }, pins: [TRIGGER] },
  { unit: { title: "On Enable", category: "Events/Lifecycle", type: "OnEnable" }, pins: [TRIGGER] },
  { unit: { title: "On Trigger Enter", category: "Events/Physics", type: "OnTriggerEnter" }, pins: [TRIGGER, ["collider", "out", "Collider"]] },
  { unit: { title: "On Collision Enter", category: "Events/Physics", type: "OnCollisionEnter" }, pins: [TRIGGER, ["collider", "out", "Collider"], ["contacts", "out", "ContactPoint[]"]] },
  { unit: { title: "On Keyboard Input", category: "Events/Input", type: "OnKeyboardInput" }, pins: [TRIGGER, ["key", "in", "KeyCode", "Space"], ["action", "in", "PressState", "Down"]] },
  { unit: { title: "Custom Event", category: "Events", type: "custom_event" }, pins: [TRIGGER, ["name", "in", "String", ""]] },
  { unit: { title: "Trigger Custom Event", category: "Events", type: "TriggerCustomEvent" }, pins: [ENTER, EXIT, ["name", "in", "String", ""], ["target", "in", "GameObject"]] },
  { unit: { title: "If", category: "Control", type: "If" }, pins: [ENTER, ["condition", "in", "Boolean", "False"], ["ifTrue", "out", "exec"], ["ifFalse", "out", "exec"]] },
  { unit: { title: "Sequence", category: "Control", type: "Sequence" }, pins: [ENTER, ["0", "out", "exec"], ["1", "out", "exec"]] },
  { unit: { title: "For Loop", category: "Control", type: "For" }, pins: [ENTER, ["firstIndex", "in", "Int32", "0"], ["lastIndex", "in", "Int32", "10"], ["step", "in", "Int32", "1"], ["body", "out", "exec"], ["exit", "out", "exec"], ["currentIndex", "out", "Int32"]] },
  { unit: { title: "For Each Loop", category: "Control", type: "ForEach" }, pins: [ENTER, ["collection", "in", "IEnumerable"], ["body", "out", "exec"], ["exit", "out", "exec"], ["item", "out", "object"]] },
  { unit: { title: "While Loop", category: "Control", type: "While" }, pins: [ENTER, ["condition", "in", "Boolean", "False"], ["body", "out", "exec"], ["exit", "out", "exec"]] },
  { unit: { title: "Once", category: "Control", type: "Once" }, pins: [ENTER, ["reset", "in", "exec"], ["once", "out", "exec"], ["after", "out", "exec"]] },
  { unit: { title: "Cooldown", category: "Time", type: "Cooldown" }, pins: [ENTER, ["duration", "in", "Single", "1"], ["ready", "out", "exec"], ["notReady", "out", "exec"]] },
  { unit: { title: "Wait For Seconds", category: "Time", type: "WaitForSecondsUnit" }, pins: [ENTER, ["seconds", "in", "Single", "1"], EXIT] },
  { unit: { title: "Timer", category: "Time", type: "Timer" }, pins: [["start", "in", "exec"], ["duration", "in", "Single", "1"], ["started", "out", "exec"], ["tick", "out", "exec"], ["completed", "out", "exec"]] },
  { unit: { title: "Debug: Log", category: "Codebase/Debug", type: "call", function: "UnityEngine.Debug:Log" }, pins: [ENTER, ["message", "in", "object", ""], EXIT] },
  { unit: { title: "Transform: Translate", category: "Codebase/Transform", type: "call", function: "UnityEngine.Transform:Translate" }, pins: [ENTER, ["target", "in", "Transform"], ["translation", "in", "Vector3", "(0, 0, 0)"], EXIT] },
  { unit: { title: "Transform: Rotate", category: "Codebase/Transform", type: "call", function: "UnityEngine.Transform:Rotate" }, pins: [ENTER, ["target", "in", "Transform"], ["eulers", "in", "Vector3", "(0, 0, 0)"], EXIT] },
  { unit: { title: "Game Object: Set Active", category: "Codebase/GameObject", type: "call", function: "UnityEngine.GameObject:SetActive" }, pins: [ENTER, ["target", "in", "GameObject"], ["value", "in", "Boolean", "True"], EXIT] },
  { unit: { title: "Object: Destroy", category: "Codebase/Object", type: "call", function: "UnityEngine.Object:Destroy" }, pins: [ENTER, ["obj", "in", "Object"], EXIT] },
  { unit: { title: "Object: Instantiate", category: "Codebase/Object", type: "call", function: "UnityEngine.Object:Instantiate" }, pins: [ENTER, ["original", "in", "Object"], EXIT, ["result", "out", "Object"]] },
  { unit: { title: "Time: Get Delta Time", category: "Codebase/Time", type: "call", function: "UnityEngine.Time:deltaTime" }, pins: [["deltaTime", "out", "Single"]] },
  { unit: { title: "Input: Get Axis", category: "Codebase/Input", type: "call", function: "UnityEngine.Input:GetAxis" }, pins: [["axisName", "in", "String", "Horizontal"], ["result", "out", "Single"]] },
  { unit: { title: "Get Variable", category: "Variables", type: "get" }, pins: [["name", "in", "String", ""], ["value", "out", "object"]] },
  { unit: { title: "Set Variable", category: "Variables", type: "set" }, pins: [ENTER, ["name", "in", "String", ""], ["input", "in", "object"], EXIT, ["output", "out", "object"]] },
  { unit: { title: "Add", category: "Math/Scalar", type: "ScalarSum" }, pins: [["a", "in", "Single", "0"], ["b", "in", "Single", "0"], ["sum", "out", "Single"]] },
  { unit: { title: "Multiply", category: "Math/Scalar", type: "ScalarMultiply" }, pins: [["a", "in", "Single", "0"], ["b", "in", "Single", "1"], ["product", "out", "Single"]] },
  { unit: { title: "Greater", category: "Logic", type: "Greater" }, pins: [["a", "in", "Single", "0"], ["b", "in", "Single", "0"], ["comparison", "out", "Boolean"]] },
  { unit: { title: "Equal", category: "Logic", type: "Equal" }, pins: [["a", "in", "object"], ["b", "in", "object"], ["comparison", "out", "Boolean"]] },
  { unit: { title: "And", category: "Logic", type: "And" }, pins: [["a", "in", "Boolean", "False"], ["b", "in", "Boolean", "False"], ["result", "out", "Boolean"]] },
  { unit: { title: "Negate", category: "Logic", type: "Negate" }, pins: [["input", "in", "Boolean", "False"], ["output", "out", "Boolean"]] },
  { unit: { title: "This", category: "Nulls", type: "This" }, pins: [["self", "out", "GameObject"]] },
  { unit: { title: "Float Literal", category: "Literals", type: "literal" }, pins: [["output", "out", "Single"]] },
  { unit: { title: "Group", category: "Notes", type: "group" }, pins: [] },
  { unit: { title: "Sticky Note", category: "Notes", type: "sticky" }, pins: [] },
];

/** The palette with Unity never read: common units (Unity's own list replaces it once read). */
export const COMMON_UNITS: VsUnit[] = TEMPLATES.map((t) => t.unit);

/**
 * The node palette's matches: every word typed must be in the title or category (any order, any case); titles that
 * start with the words come first. Duplicate entries (Unity's list merged with the common one) show once.
 *
 * @param units - The units to search (Unity's list, else {@link COMMON_UNITS}).
 * @param query - The words typed.
 * @param limit - At most this many.
 * @returns The matches, best first.
 */
export function searchUnits(units: VsUnit[], query: string, limit = 60): VsUnit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const scored: Array<{ u: VsUnit; s: number; i: number }> = [];
  units.forEach((u, i) => {
    const key = `${u.type}|${u.title}|${u.function ?? ""}|${u.event ?? ""}`;
    if (seen.has(key)) return;
    const title = u.title.toLowerCase();
    const hay = `${title} ${u.category.toLowerCase()} ${u.type.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) return;
    seen.add(key);
    const q = words.join(" ");
    scored.push({ u, i, s: !q ? 0 : title === q ? 0 : title.startsWith(q) ? 1 : title.includes(q) ? 2 : 3 });
  });
  return scored.sort((a, b) => a.s - b.s || a.i - b.i).slice(0, limit).map((x) => x.u);
}

/**
 * The ports a unit gets when it is added with Unity closed: the common unit's ports when known, else a guess from its
 * kind (events: one control output; member calls and anything else: enter / exit). Unity's answer after the sync
 * replaces them.
 *
 * @param op - The add operation.
 * @returns The title, class and ports.
 */
export function unitTemplate(op: VsOp): { title: string; class: string; pins: VsPin[] } {
  const type = String(op.type ?? "unit");
  const named = String(op.unit ?? op.event ?? "");
  const fn = typeof op.function === "string" ? op.function : "";
  const key = type === "branch" ? "If" : type === "unit" || type === "event" ? named : type;
  const t = TEMPLATES.find((x) => (fn ? x.unit.function === fn : x.unit.type === key && !x.unit.function));
  const pins: VsPin[] = (t?.pins ?? guessPins(type, key, fn)).map(([name, dir, ptype, def]) => ({ name, dir, type: ptype, ...(def !== undefined ? { default: def } : {}) }));
  if ((type === "get" || type === "set") && typeof op.variable === "string") pins.find((p) => p.name === "name")!.default = op.variable;
  if (type === "custom_event" && typeof op.name === "string") pins.find((p) => p.name === "name")!.default = op.name;
  if (type === "literal") {
    const vt = String(op.valueType ?? "float");
    const map: Record<string, string> = { float: "Single", number: "Single", int: "Int32", integer: "Int32", bool: "Boolean", boolean: "Boolean", string: "String", vector2: "Vector2", vector3: "Vector3" };
    pins[0] = { name: "output", dir: "out", type: map[vt.toLowerCase()] ?? vt, ...(op.value !== undefined ? { default: String(op.value) } : {}) };
  }
  const variable = typeof op.variable === "string" ? op.variable : "";
  const title = t?.unit.title ?? (fn ? fn.replace(/^.*\./, "").replace(":", ": ") : variable ? `${type === "get" ? "Get" : "Set"} ${variable}` : spaced(key));
  const cls = type === "call" ? "InvokeMember" : type === "get" ? "GetVariable" : type === "set" ? "SetVariable" : type === "literal" ? "Literal" : type === "custom_event" ? "CustomEvent" : t?.unit.type ?? key;
  return { title: type === "get" || type === "set" ? (variable ? `${type === "get" ? "Get" : "Set"} ${variable}` : title) : title, class: cls, pins };
}

function guessPins(type: string, key: string, fn: string): PinT[] {
  if (type === "event" || /^On[A-Z]/.test(key)) return [TRIGGER];
  if (fn && /:(get_)?[a-z]/.test(fn) && !/:[A-Z]/.test(fn)) return [["value", "out", "object"]];
  return [ENTER, EXIT];
}

/** "OnTriggerEnter" → "On Trigger Enter". */
function spaced(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim() || "Node";
}

// ---------------------------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------------------------

/** A port's key on a wire ("node:pin"). */
const key = (node: string, pin: string) => `${node}:${pin}`;
const split = (link: string): [string, string] => {
  const i = link.indexOf(":");
  return [link.slice(0, i), link.slice(i + 1)];
};

/**
 * Applies operations to one tab of a graph, as the Unity package does in the open editor, without changing the input
 * (a changed copy is returned). Each operation answers on its own; a failed one changes nothing.
 *
 * Operations: `add` (type: a unit class, unit / event, call + function, get / set + variable, literal + valueType,
 * custom_event, group / comment_box / sticky + width, height, text; `ref` names it for later operations; `id` keeps a
 * given id), `delete`, `move`, `connect` (from → to, with the type rules; an input value port and a control output
 * keep one wire, so the old one goes), `disconnect` (every wire of a port), `set` (an input port's value),
 * `resize` and `comment` (groups and sticky notes).
 *
 * @param doc - The graph.
 * @param graphName - The tab (the first one when not found).
 * @param ops - The operations, in order.
 * @param newId - Makes the id of an added element (default: "new-" and a running number).
 * @returns The changed copy and one result per operation.
 */
export function applyVsOps(doc: VsDoc, graphName: string, ops: VsOp[], newId?: (n: number) => string): { doc: VsDoc; results: VsResult[] } {
  const copy: VsDoc = JSON.parse(JSON.stringify(doc)) as VsDoc;
  const tab = copy.graphs.find((g) => g.name === graphName) ?? copy.graphs[0];
  if (!tab) return { doc: copy, results: ops.map((o) => ({ op: String(o.op ?? ""), ok: false, error: "The graph has no tabs" })) };
  const states = tab.name === "States" || tab.name.endsWith(" · States");
  const refs = new Map<string, string>();
  let counter = 0;
  const makeId = (op: VsOp) => {
    if (typeof op.id === "string" && op.id && !tab.nodes.some((n) => n.id === op.id)) return op.id;
    let id = "";
    do id = newId ? newId(++counter) : `new-${tab.nodes.length + ++counter}`;
    while (tab.nodes.some((n) => n.id === id));
    return id;
  };
  const nodeOf = (id: unknown) => {
    const s = String(id ?? "");
    const real = refs.get(s) ?? s;
    return tab.nodes.find((n) => n.id === real);
  };
  const pinOf = (n: VsNode | undefined, name: unknown, dir?: "in" | "out") => n?.pins.find((p) => p.name === String(name ?? "") && (!dir || p.dir === dir));
  const unlink = (n: VsNode, p: VsPin) => {
    for (const l of p.links ?? []) {
      const [on, op] = split(l);
      const other = tab.nodes.find((x) => x.id === on)?.pins.find((x) => x.name === op && x.dir !== p.dir);
      if (other?.links) {
        other.links = other.links.filter((x) => x !== key(n.id, p.name));
        if (!other.links.length) delete other.links;
      }
    }
    delete p.links;
  };
  const results: VsResult[] = [];
  for (const op of ops) {
    const kind = String(op.op ?? "");
    let error: string | undefined;
    let made: string | undefined;
    try {
      switch (kind) {
        case "add": {
          const type = String(op.type ?? "");
          const id = makeId(op);
          const x = Number(op.x ?? 0) || 0;
          const y = Number(op.y ?? 0) || 0;
          if (type === "group" || type === "comment_box" || type === "sticky") {
            const text = String(op.text ?? op.name ?? (type === "sticky" ? "Note" : "Group")).slice(0, 200);
            tab.nodes.push({ id, title: text, comment: text, class: type === "sticky" ? "StickyNote" : "GraphGroup", x, y, width: Math.max(40, Number(op.width ?? 400) || 400), height: Math.max(30, Number(op.height ?? 200) || 200), pins: [] });
          } else if (states) {
            if (!/^(state|flow_state|super_state|any_state)$/.test(type)) throw new Error(`In the States tab, add a state (not ${type || "a unit"})`);
            const title = type === "any_state" ? "Any State" : String(op.name ?? (type === "super_state" ? "Super State" : "New State"));
            tab.nodes.push({ id, title, class: type === "super_state" ? "SuperState" : type === "any_state" ? "AnyState" : "FlowState", x, y, pins: [{ name: "in", dir: "in", type: "exec" }, { name: "out", dir: "out", type: "exec" }] });
          } else {
            if (!type) throw new Error("Which node?");
            if (type === "call" && !op.function) throw new Error("Which method?");
            const t = unitTemplate(op);
            tab.nodes.push({ id, title: t.title, class: t.class, x, y, pins: t.pins, ...(typeof op.function === "string" ? { function: op.function } : {}), ...(typeof op.variable === "string" ? { variable: op.variable } : {}) });
          }
          if (typeof op.ref === "string" && op.ref) refs.set(op.ref, id);
          made = id;
          break;
        }
        case "delete": {
          const n = nodeOf(op.node);
          if (!n) throw new Error("Node not found");
          for (const p of n.pins) unlink(n, p);
          tab.nodes = tab.nodes.filter((x) => x !== n);
          break;
        }
        case "move": {
          const n = nodeOf(op.node);
          if (!n) throw new Error("Node not found");
          if (op.x !== undefined) n.x = Number(op.x) || 0;
          if (op.y !== undefined) n.y = Number(op.y) || 0;
          break;
        }
        case "resize": {
          const n = nodeOf(op.node);
          if (!n || !isVsNote(n)) throw new Error("Only groups and sticky notes change size");
          n.width = Math.max(40, Number(op.width ?? n.width) || 400);
          n.height = Math.max(30, Number(op.height ?? n.height) || 200);
          break;
        }
        case "comment": {
          const n = nodeOf(op.node);
          if (!n || !isVsNote(n)) throw new Error("Unity units have no comment: put them in a group (C)");
          n.comment = n.title = String(op.text ?? "").slice(0, 200);
          break;
        }
        case "set": {
          const n = nodeOf(op.node);
          const p = pinOf(n, op.pin, "in");
          if (!n || !p || p.type === "exec") throw new Error(`Input not found: ${String(op.pin ?? "")}`);
          p.default = String(op.value ?? "");
          if (n.class === "GetVariable" || n.class === "SetVariable") if (p.name === "name") n.title = `${n.class === "GetVariable" ? "Get" : "Set"} ${p.default}`;
          break;
        }
        case "disconnect": {
          const n = nodeOf(op.node);
          const p = pinOf(n, op.pin);
          if (!n || !p) throw new Error(`Port not found: ${String(op.node ?? "")}.${String(op.pin ?? "")}`);
          unlink(n, p);
          break;
        }
        case "connect": {
          const f = (op.from ?? {}) as { node?: string; pin?: string };
          const t = (op.to ?? {}) as { node?: string; pin?: string };
          const a = nodeOf(f.node);
          const b = nodeOf(t.node);
          const pa = pinOf(a, f.pin, "out");
          const pb = pinOf(b, t.pin, "in");
          if (!a || !b || !pa || !pb) throw new Error(`Port not found: ${String(f.node)}.${String(f.pin)} → ${String(t.node)}.${String(t.pin)}`);
          if (a === b && !states) throw new Error("A node does not connect to itself");
          const fit = unityPortsFit(pa.type, pb.type);
          if (!fit.ok) throw new Error(`These ports cannot be connected: ${pa.name} → ${pb.name} (${fit.why})`);
          if (states) {
            if (b.class === "AnyState") throw new Error("Nothing can go into Any State");
          } else {
            // Unity keeps one wire into a value input and one out of a control output: the new one replaces it.
            if (pb.type !== "exec") unlink(b, pb);
            if (pa.type === "exec") unlink(a, pa);
          }
          const ka = key(b.id, pb.name);
          const kb = key(a.id, pa.name);
          pa.links = [...new Set([...(pa.links ?? []), ka])];
          pb.links = [...new Set([...(pb.links ?? []), kb])];
          break;
        }
        default:
          throw new Error(`Unknown operation ${kind}`);
      }
    } catch (e) {
      error = (e as Error).message;
    }
    results.push({ op: kind, ok: !error, ...(error ? { error } : {}), ...(made ? { node: made } : {}) });
  }
  return { doc: copy, results };
}

/**
 * Whether a wire may go from one port to another in this tab, said the way the page shows it while dragging.
 *
 * @param tab - The tab.
 * @param from - The output port (node id, pin name).
 * @param to - The input port.
 * @returns ok, and why.
 */
export function canConnectVs(tab: VsGraph, from: { node: string; pin: string }, to: { node: string; pin: string }): { ok: boolean; why: string } {
  const pa = tab.nodes.find((n) => n.id === from.node)?.pins.find((p) => p.name === from.pin && p.dir === "out");
  const pb = tab.nodes.find((n) => n.id === to.node)?.pins.find((p) => p.name === to.pin && p.dir === "in");
  if (!pa || !pb) return { ok: false, why: "Port not found" };
  if (from.node === to.node) return { ok: false, why: "A node does not connect to itself" };
  return unityPortsFit(pa.type, pb.type);
}

// ---------------------------------------------------------------------------------------------------------------
// Comparing (sync on open)
// ---------------------------------------------------------------------------------------------------------------

/** What changed between two versions of a graph. */
export interface VsDiff { same: boolean; added: string[]; removed: string[]; moved: number; rewired: number; values: number; tabs: { added: string[]; removed: string[] } }

/**
 * What Unity changed compared with the saved copy, tab by tab (by element id): elements added and removed (titles),
 * how many moved, had their wires changed, or had a value changed. Used when the page opens a graph to offer
 * "Refresh" when Unity's graph is not the copy shown.
 *
 * @param saved - The copy KesherAI has.
 * @param now - Unity's graph now.
 * @returns The differences (at most 30 titles each).
 */
export function diffVsGraphs(saved: VsDoc, now: VsDoc): VsDiff {
  const out: VsDiff = { same: true, added: [], removed: [], moved: 0, rewired: 0, values: 0, tabs: { added: [], removed: [] } };
  const savedTabs = new Map(saved.graphs.map((g) => [g.name, g]));
  const nowTabs = new Map(now.graphs.map((g) => [g.name, g]));
  out.tabs.added = [...nowTabs.keys()].filter((k) => !savedTabs.has(k));
  out.tabs.removed = [...savedTabs.keys()].filter((k) => !nowTabs.has(k));
  const links = (n: VsNode) => n.pins.map((p) => `${p.dir}${p.name}>${[...(p.links ?? [])].sort().join(",")}`).join("|");
  const values = (n: VsNode) => n.pins.map((p) => `${p.name}=${p.default ?? ""}`).join("|") + `|${n.title}|${n.comment ?? ""}`;
  for (const [name, g] of nowTabs) {
    const before = new Map((savedTabs.get(name)?.nodes ?? []).map((n) => [n.id, n]));
    const after = new Map(g.nodes.map((n) => [n.id, n]));
    for (const [id, n] of after) {
      const b = before.get(id);
      if (!b) out.added.push(n.title);
      else {
        if (Math.round(b.x) !== Math.round(n.x) || Math.round(b.y) !== Math.round(n.y) || (b.width ?? 0) !== (n.width ?? 0) || (b.height ?? 0) !== (n.height ?? 0)) out.moved++;
        if (links(b) !== links(n)) out.rewired++;
        if (values(b) !== values(n)) out.values++;
      }
    }
    for (const [id, n] of before) if (!after.has(id)) out.removed.push(n.title);
  }
  for (const name of out.tabs.removed) for (const n of savedTabs.get(name)!.nodes) out.removed.push(n.title);
  const vars = (d: VsDoc) => JSON.stringify([...(d.variables ?? [])].sort((a, b) => a.name.localeCompare(b.name)));
  out.same = !out.added.length && !out.removed.length && !out.moved && !out.rewired && !out.values && !out.tabs.added.length && vars(saved) === vars(now);
  out.added = out.added.slice(0, 30);
  out.removed = out.removed.slice(0, 30);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------------------------------------------

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/**
 * Reads a graph from JSON text (a saved copy, or the package's answer) and checks its shape: unknown fields are
 * dropped, text is capped, numbers are numbers, wires point both ways. Throws when it is not a graph.
 *
 * @param text - The JSON.
 * @returns The graph.
 */
export function parseVsDoc(text: string): VsDoc {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.graphs)) throw new Error("Not a Visual Scripting graph");
  const pin = (p: Record<string, unknown>): VsPin => {
    const links = Array.isArray(p.links) ? p.links.map((l) => str(l, 200)).filter((l): l is string => !!l && l.includes(":")) : [];
    const label = str(p.label, 120);
    const def = str(p.default, 2000);
    return { name: str(p.name, 120) ?? "", ...(label !== undefined ? { label } : {}), dir: p.dir === "out" ? "out" : "in", type: str(p.type, 200) ?? "object", ...(def !== undefined ? { default: def } : {}), ...(links.length ? { links } : {}) };
  };
  const node = (n: Record<string, unknown>): VsNode => {
    const out: VsNode = { id: str(n.id, 100) ?? "", title: str(n.title, 300) ?? "", class: str(n.class, 200) ?? "", x: num(n.x), y: num(n.y), pins: Array.isArray(n.pins) ? (n.pins as Array<Record<string, unknown>>).map(pin) : [] };
    for (const k of ["comment", "color", "body", "function", "variable"] as const) {
      const v = str(n[k], k === "body" ? 4000 : 500);
      if (v !== undefined) out[k] = v;
    }
    if (n.width !== undefined) out.width = num(n.width);
    if (n.height !== undefined) out.height = num(n.height);
    return out;
  };
  const graphs: VsGraph[] = (raw.graphs as Array<Record<string, unknown>>).map((g) => ({ name: str(g.name, 300) ?? "", kind: g.kind === "event" || g.kind === "macro" ? g.kind : "function", nodes: Array.isArray(g.nodes) ? (g.nodes as Array<Record<string, unknown>>).map(node) : [] }));
  const variables: VsVariable[] = Array.isArray(raw.variables)
    ? (raw.variables as Array<Record<string, unknown>>).map((v) => {
        const out: VsVariable = { name: str(v.name, 200) ?? "", type: str(v.type, 200) ?? "object" };
        for (const k of ["ptype", "default", "tooltip", "category"] as const) {
          const s = str(v[k], 2000);
          if (s !== undefined) out[k] = s;
        }
        if (typeof v.editable === "boolean") out.editable = v.editable;
        if (typeof v.private === "boolean") out.private = v.private;
        return out;
      })
    : [];
  const parent = str(raw.parent, 100);
  return { path: str(raw.path, 1000) ?? "", name: str(raw.name, 300) ?? "", ...(parent !== undefined ? { parent } : {}), variables, graphs };
}

/**
 * Writes a graph as stable JSON (the same graph always gives the same text, so saved copies compare and diff well).
 *
 * @param doc - The graph.
 * @returns The JSON text; {@link parseVsDoc} reads it back to an equal graph.
 */
export function serializeVsDoc(doc: VsDoc): string {
  return JSON.stringify(parseVsDoc(JSON.stringify(doc)));
}
