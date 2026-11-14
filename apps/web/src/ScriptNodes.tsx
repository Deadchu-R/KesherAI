import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { addField, addKnot, breakExec, collapseToFunction, csValue, deleteStep, fieldUses, insertStep, isKnotId, locate, methodToNodes, newId, parseCSharp, placeAlone, plainValue, realPin, removeField, removeKnot, updateField, wireExec, withKnots, writeCSharp, type CsAccess, type CsClass, type CsLayout, type CsStmt } from "@kesher/shared";
import { api } from "./api";
import { BlueprintCanvas, type Action } from "./BlueprintCanvas";
import { Fullscreen } from "./Fullscreen";
import { CodeAiBubble } from "./CodeAiBubble";
import type { CodeProblem } from "./ide/CodeEditor";
// The code editor (VS Code's) is big: loaded when the C# tab first opens.
const CodeEditor = lazy(() => import("./ide/CodeEditor"));
import { VariablesPanel, type PanelType, type PanelVar } from "./VariablesPanel";
import { getLocale } from "./i18n";
import { toast } from "./library";
import { Select } from "./ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** What each kind of node is called, in words for people who do not code. */
const KIND: Record<CsStmt["kind"], [string, string]> = {
  if: ["תנאי (אם…)", "Condition (if…)"],
  loop: ["לולאה (חוזר על…)", "Loop (repeat…)"],
  call: ["פעולה", "Action"],
  set: ["שינוי ערך", "Change a value"],
  local: ["משתנה חדש", "New variable"],
  return: ["החזרת ערך", "Return a value"],
  code: ["קוד", "Code"],
};

/** Types a Unity variable can have; the project's own scripts are added to these. */
const UNITY_TYPES: PanelType[] = [
  ...(["bool", "int", "float", "string"] as const).map((t): PanelType => ({ value: t, label: t, input: t === "bool" ? "bool" : t === "string" ? "text" : "number", group: L("בסיסי", "Basic") })),
  ...["Vector2", "Vector3", "Color"].map((t): PanelType => ({ value: t, label: t, input: "code", group: "Unity" })),
  ...["GameObject", "Transform", "Rigidbody", "Rigidbody2D", "Collider", "Animator", "AudioSource", "AudioClip", "Sprite", "Material", "Camera", "ParticleSystem"].map((t): PanelType => ({ value: t, label: t, input: "none", group: "Unity" })),
];

/** Common Unity actions for the "All Actions" menu (right-click or Space on the graph, as in Unreal). */
const UNITY_CALLS: Array<{ title: string; target: string; name: string; args: string[] }> = [
  { title: "Print to Console (Debug.Log)", target: "Debug", name: "Log", args: ['"Hello"'] },
  { title: "Move (transform.Translate)", target: "transform", name: "Translate", args: ["Vector3.forward * Time.deltaTime"] },
  { title: "Rotate (transform.Rotate)", target: "transform", name: "Rotate", args: ["0f", "90f * Time.deltaTime", "0f"] },
  { title: "Look At (transform.LookAt)", target: "transform", name: "LookAt", args: ["Vector3.zero"] },
  { title: "Show / Hide (gameObject.SetActive)", target: "gameObject", name: "SetActive", args: ["false"] },
  { title: "Destroy Object (Destroy)", target: "", name: "Destroy", args: ["gameObject"] },
  { title: "Spawn a Copy (Instantiate)", target: "", name: "Instantiate", args: ["gameObject", "transform.position", "Quaternion.identity"] },
  { title: "Call Later (Invoke)", target: "", name: "Invoke", args: ['"MethodName"', "1f"] },
  { title: "Push (Rigidbody.AddForce)", target: "GetComponent<Rigidbody>()", name: "AddForce", args: ["Vector3.up * 5f"] },
  { title: "Push 2D (Rigidbody2D.AddForce)", target: "GetComponent<Rigidbody2D>()", name: "AddForce", args: ["Vector2.up * 5f"] },
  { title: "Play Sound (AudioSource.Play)", target: "GetComponent<AudioSource>()", name: "Play", args: [] },
  { title: "Play Animation (Animator.Play)", target: "GetComponent<Animator>()", name: "Play", args: ['"StateName"'] },
  { title: "Load Scene (SceneManager.LoadScene)", target: "UnityEngine.SceneManagement.SceneManager", name: "LoadScene", args: ['"SceneName"'] },
];

/**
 * A Unity C# script as nodes, for people who do not write code: pick a
 * script, pick a method (Start, Update, OnTriggerEnter…), see it as a graph,
 * change a node's values in the panel (a condition, an action's inputs, a new
 * value), remove or move a step, and write it back as C#. Only the methods
 * that changed are rewritten; the rest of the file stays exactly as it was.
 */
export function ScriptNodes() {
  const [scripts, setScripts] = useState<string[] | null>(null);
  const [searched, setSearched] = useState<{ folders: number; partial: boolean; error?: string }>({ folders: 0, partial: false });
  const loadScripts = () => {
    setScripts(null);
    void api<{ scripts: string[]; folders: number; partial: boolean }>("/api/unity/scripts").then(
      (r) => { setScripts(r.scripts); setSearched({ folders: r.folders ?? 0, partial: !!r.partial }); },
      (e: Error) => { setScripts([]); setSearched({ folders: 0, partial: false, error: e.message }); },
    );
  };
  const [q, setQ] = useState("");
  const [path, setPath] = useState("");
  const [file, setFile] = useState<{ text: string; mtime: number } | null>(null);
  /** The script with every change so far (variables, typed code); node edits are on top of it. */
  const [text, setTextState] = useState("");
  const [classes, setClasses] = useState<CsClass[]>([]);
  const [ci, setCi] = useState(0);
  const [method, setMethod] = useState("");
  const [sel, setSel] = useState("");
  const [show, setShow] = useState<"nodes" | "code">("nodes");
  const [tick, setTick] = useState(0);
  /** Where each node was put, and the steps placed on the graph but not wired in (kept by KesherAI, not in the code). */
  const layoutRef = useRef<CsLayout>({});
  const saveTimer = useRef(0);
  const saveLayout = () => {
    clearTimeout(saveTimer.current);
    const p = path;
    saveTimer.current = window.setTimeout(() => void api("/api/unity/script/layout", { method: "PUT", body: { path: p, layout: layoutRef.current } }).catch(() => undefined), 600);
  };
  const [saving, setSaving] = useState(false);
  /** Unity's compile errors for this script (file, line, column), and whether a check is running. */
  const [problems, setProblems] = useState<Array<CodeProblem & { file: string }>>([]);
  const [checking, setChecking] = useState(false);
  /** The script before the AI's last change (one click puts it back). */
  const [beforeAi, setBeforeAi] = useState<string | null>(null);
  /** Rider mode: the C# language server (csharp-ls) for the project, when installed. */
  const [lsp, setLsp] = useState<{ installed: boolean; dotnet: boolean; solution: boolean; project: string | null } | null>(null);
  const [lspStatus, setLspStatus] = useState("");
  const [installing, setInstalling] = useState(false);
  const loadLsp = () => void api<NonNullable<typeof lsp>>("/api/lsp/csharp").then(setLsp, () => setLsp(null));
  useEffect(loadLsp, []);
  const installLsp = async () => {
    setInstalling(true);
    try {
      const r = await api<{ ok: boolean; out: string }>("/api/lsp/csharp/install", { method: "POST" });
      toast(r.ok ? L("מצב Rider מותקן.", "Rider mode is installed.") : r.out.slice(-300));
      loadLsp();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  useEffect(() => {
    loadScripts();
  }, []);

  const open = (p: string) => {
    if (p !== path) {
      setProblems([]);
      setBeforeAi(null);
    }
    setPath(p);
    setSel("");
    layoutRef.current = {};
    void api<CsLayout>(`/api/unity/script/layout?path=${encodeURIComponent(p)}`).then((l) => {
      layoutRef.current = l && typeof l === "object" ? l : {};
      setTick((x) => x + 1);
    }, () => undefined);
    void api<{ text: string; mtime: number }>(`/api/unity/script?path=${encodeURIComponent(p)}`).then((r) => {
      setFile(r);
      setTextState(r.text);
      const parsed = parseCSharp(r.text);
      setClasses(parsed);
      // The class named like the file is the script's own (MonoBehaviour); others are helpers.
      const own = Math.max(0, parsed.findIndex((c) => c.name === p.split("/").pop()!.replace(/\.cs$/, "")));
      setCi(own);
      setMethod(parsed[own]?.methods[0]?.id ?? "");
    }, (e: Error) => toast(e.message));
  };
  /** Takes new text for the script (typed code, a variable change) and reads it again, keeping the open method. */
  const setText = (next: string) => {
    const name = classes.flatMap((c) => c.methods).find((x) => x.id === method)?.name;
    const parsed = parseCSharp(next);
    setTextState(next);
    setClasses(parsed);
    setMethod(parsed[ci]?.methods.find((x) => x.name === name)?.id ?? parsed[ci]?.methods[0]?.id ?? "");
    setSel("");
  };

  const m = classes.flatMap((c) => c.methods).find((x) => x.id === method);
  const keyOf = useRef(new Map<string, string>());
  const nodes = useMemo(() => {
    if (!m) return [];
    const list = methodToNodes(m, layoutRef.current);
    // A node whose key changed (its target or name was edited) keeps the place it was given.
    const pos = (layoutRef.current.positions ??= {});
    for (const n of list) {
      const old = keyOf.current.get(n.id);
      if (n.key && old && old !== n.key && pos[old] && !pos[n.key]) {
        pos[n.key] = pos[old]!;
        n.x = pos[n.key]!.x;
        n.y = pos[n.key]!.y;
      }
      if (n.key) keyOf.current.set(n.id, n.key);
    }
    return list;
  }, [m, tick]);
  // The graph as drawn: with its reroute nodes; one whose wire is gone is dropped from the layout.
  const drawn = useMemo(() => {
    if (!m) return [];
    const knots = layoutRef.current.knots?.[m.name] ?? [];
    const r = withKnots(nodes, knots);
    if (r.live.length !== knots.length) {
      layoutRef.current.knots![m.name] = r.live;
      saveLayout();
    }
    return r.nodes;
  }, [nodes]);
  const out = useMemo(() => (file ? writeCSharp(text, classes) : ""), [file, text, classes, tick]);
  const changed = !!file && out !== file.text;
  const found = m && sel ? locate(m, layoutRef.current, sel) : undefined;
  const st = found?.stmt;
  const edit = (f: (s: CsStmt) => void) => {
    if (!st) return;
    f(st);
    st.dirty = true;
    setTick((t) => t + 1);
  };
  const move = (by: -1 | 1) => {
    if (!found) return;
    const j = found.index + by;
    if (j < 0 || j >= found.list.length) return;
    [found.list[found.index], found.list[j]] = [found.list[j]!, found.list[found.index]!];
    found.list[found.index]!.dirty = true;
    found.list[j]!.dirty = true;
    setTick((t) => t + 1);
  };
  const remove = () => {
    if (!found || !m) return;
    found.list.splice(found.index, 1);
    // An emptied method is still rewritten.
    (m as typeof m & { dirty?: boolean }).dirty = true;
    if (found.list[found.index]) found.list[found.index]!.dirty = true;
    setSel("");
    setTick((t) => t + 1);
  };
  /**
   * Wires drawn on the graph, turned into the C# they mean (Roee, 2026-11-13: "connecting nodes does not work"):
   * - a flow wire (then → execute) puts the step right after the one it comes from (or first inside a Branch's
   *   True/False or a Loop's body);
   * - a value wire from the method's input (a parameter) to a step's input writes that name there;
   * - Delete removes steps; Alt+click on an input clears it. Moving a node only moves the picture.
   */
  /** What the "All Actions" menu offers here (right-click or Space on the graph, as in Unreal), by the words typed. */
  const localActions = (q: string): Action[] => {
    const all: Action[] = [
      { title: L("תנאי (Branch)", "Branch (if)"), category: L("זרימה", "Flow"), type: "if" },
      { title: L("משתנה חדש בתוך המתודה", "New local variable"), category: L("משתנים", "Variables"), type: "local" },
      ...(cls?.fields ?? []).map((f): Action => ({ title: `Set ${f.name}`, category: L("משתנים", "Variables"), type: "set", variable: f.name })),
      ...UNITY_CALLS.map((c): Action => ({ title: c.title, category: "Unity", type: "call", target: c.target, function: c.name, args: c.args })),
      ...(cls?.methods ?? []).filter((x) => x.id !== m?.id).map((x): Action => ({ title: `${x.name}()`, category: L("המתודות של הסקריפט", "This script's methods"), type: "call", target: "", function: x.name, args: x.params.map(() => "0") })),
    ];
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((a) => words.every((w) => `${a.title} ${a.category} ${a.function ?? ""}`.toLowerCase().includes(w))).slice(0, 60);
  };
  /** A C# value's type, for a new variable made from it (Promote to Variable). */
  const typeOfValue = (v: string, pinType: string): string => {
    const s = v.trim();
    if (/^(true|false)$/.test(s)) return "bool";
    if (/^-?\d+$/.test(s)) return "int";
    if (/^-?\d*\.?\d+f?$/.test(s)) return "float";
    if (/^".*"$/.test(s)) return "string";
    const ctor = /^new\s+(Vector2|Vector3|Color|Quaternion)\b/.exec(s);
    if (ctor) return ctor[1]!;
    if (/^(bool|int|float|string|Vector2|Vector3|Color)$/.test(pinType)) return pinType;
    return "float";
  };
  const graphOps = (ops: Array<Record<string, unknown>>): Array<{ ok: boolean; error?: string; node?: string; text?: string; nodes?: string[] }> => {
    if (!m) return ops.map(() => ({ ok: false, error: L("אין מתודה פתוחה.", "No method is open.") }));
    const knots = layoutRef.current.knots?.[m.name] ?? [];
    const results = ops.map((op): { ok: boolean; error?: string; node?: string; text?: string; nodes?: string[] } => {
      // Reroute nodes (dots on wires) are only on the graph: their own ops here, and a wire through them stands for
      // the real wire (from its source to its end).
      if (op.op === "reroute") {
        addKnot(layoutRef.current, m.name, String(op.from), String(op.to), Number(op.x ?? 0), Number(op.y ?? 0));
        saveLayout();
        return { ok: true };
      }
      if ((op.op === "move" || op.op === "delete") && isKnotId(String(op.node))) {
        const k = knots.find((x) => x.id === op.node);
        if (!k) return { ok: true };
        if (op.op === "delete") removeKnot(layoutRef.current, m.name, k.id);
        else {
          k.x = Number(op.x);
          k.y = Number(op.y);
        }
        saveLayout();
        return { ok: true };
      }
      const real = (node: string, pin: string) => {
        const r = realPin(knots, `${node}:${pin}`);
        const at = r.lastIndexOf(":");
        return { node: r.slice(0, at), pin: r.slice(at + 1) };
      };
      if (op.op === "disconnect" && (op.link || isKnotId(String(op.node)))) {
        // One wire (chosen and deleted, or Alt+click on a reroute node): break it at its end, which takes one wire.
        const end = isKnotId(String(op.node)) ? real(String(op.node), "InputPin") : real(String(op.node), String(op.pin));
        op = { op: "disconnect", node: end.node, pin: end.pin };
      }
      if (op.op === "connect") {
        const f = op.from as { node: string; pin: string };
        const t = op.to as { node: string; pin: string };
        op = { ...op, from: real(f.node, f.pin), to: real(t.node, t.pin) };
      }
      if (op.op === "add" && op.from && isKnotId((op.from as { node: string }).node)) {
        const f = op.from as { node: string; pin: string; dir: string; type: string };
        op = { ...op, from: { ...f, ...real(f.node, f.pin) } };
      }
      if (op.op === "copy") op = { ...op, nodes: (op.nodes as string[]).filter((id) => !isKnotId(id)) };
      if (op.op === "move") {
        // Nodes stay where they are put, as in Unreal (saved with the script's graph, not in the code).
        const n = nodes.find((x) => x.id === op.node);
        if (n?.key) (layoutRef.current.positions ??= {})[n.key] = { x: Number(op.x), y: Number(op.y) };
        saveLayout();
        return { ok: true };
      }
      if (op.op === "add") {
        // A node chosen in the menu lands where it was asked for, wired to nothing (as in Unreal); dragged from an
        // exec pin, it is wired there.
        const a = op.action as Action;
        const stmt: CsStmt =
          a.type === "call" ? { id: newId(), kind: "call", target: a.target ?? "", name: a.function ?? "Log", args: [...(a.args ?? [])], src: "", dirty: true }
          : a.type === "set" ? fresh("set", a.variable)
          : a.type === "local" ? fresh("local")
          : fresh("if");
        const x = Number(op.x ?? 0);
        const y = Number(op.y ?? 0);
        const id = placeAlone(m, layoutRef.current, stmt, x, y);
        const from = op.from as { node: string; pin: string; dir: string; type: string } | undefined;
        if (from && from.dir === "out" && from.type === "exec") {
          const was = nodes.find((n) => n.id === from.node)?.pins.find((p) => p.name === from.pin)?.links?.[0];
          const next = was ? nodes.find((n) => `${n.id}:execute` === was) : undefined;
          const err = wireExec(m, layoutRef.current, from, id, { x: next?.x ?? x, y: (next?.y ?? y) + 220 });
          if (err) toast(err);
        }
        setSel(id);
        saveLayout();
        return { ok: true, node: id };
      }
      if (op.op === "copy") {
        // Ctrl+C: the chosen steps as text (pasted into this or another script).
        const steps = (op.nodes as string[]).map((id) => locate(m, layoutRef.current, id)?.stmt).filter((x): x is CsStmt => !!x);
        if (!steps.length) return { ok: false, error: L("אין צעדים להעתקה.", "No steps to copy.") };
        return { ok: true, text: JSON.stringify(steps) };
      }
      if (op.op === "paste") {
        // Ctrl+V: copied steps, with new ids, after the chosen step (or last).
        let steps: CsStmt[];
        try {
          steps = JSON.parse(String(op.text)) as CsStmt[];
        } catch {
          return { ok: false, error: L("אין צעדים להדבקה.", "Nothing to paste.") };
        }
        const renew = (s: CsStmt): CsStmt => {
          const c = { ...s, id: newId(), dirty: true } as CsStmt;
          if (c.kind === "if") {
            c.then = c.then.map(renew);
            if (c.else) c.else = c.else.map(renew);
          } else if (c.kind === "loop") c.body = c.body.map(renew);
          return c;
        };
        // Pasted nodes land at the mouse, wired to nothing (as in Unreal).
        const fresh2 = steps.filter((s) => s && typeof s === "object" && "kind" in s).map(renew);
        const ids = fresh2.map((s, i) => placeAlone(m, layoutRef.current, s, Number(op.x ?? 0) + i * 40, Number(op.y ?? 0) + i * 40));
        saveLayout();
        return { ok: true, nodes: ids };
      }
      if (op.op === "collapse") {
        // Collapse to Function: the steps move into a new method of the class; a call takes their place.
        const r = collapseToFunction(text, classes, ci, m.name, (op.nodes as string[]).filter((x) => !isKnotId(x)), String(op.name));
        if ("error" in r) return { ok: false, error: r.error };
        setTimeout(() => {
          setText(r.text);
          toast(L(`נוצרה הפונקציה ${String(op.name)}: לחצו עליה בלשוניות המתודות כדי לראות את הגרף שלה.`, `Made the function ${String(op.name)}: choose it in the method tabs to see its graph.`));
        }, 0);
        return { ok: true };
      }
      if (op.op === "usevar") {
        // A variable dropped from the panel on a step's input: the input takes the variable (as a Get node wired in).
        const f = locate(m, layoutRef.current, String(op.node));
        const pin = String(op.pin);
        const name = String(op.name);
        if (!f || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ok: false, error: L("לכניסה הזאת אי אפשר לתת משתנה.", "This input cannot take a variable.") };
        const s6 = f.stmt;
        if (s6.kind === "call" && /^arg\d+$/.test(pin)) s6.args[Number(pin.slice(3))] = name;
        else if ((s6.kind === "set" || s6.kind === "local" || s6.kind === "return") && pin === "value") (s6 as { value?: string }).value = name;
        else if (s6.kind === "if" && pin === "Condition") s6.cond = name;
        else return { ok: false, error: L("לכניסה הזאת אי אפשר לתת משתנה.", "This input cannot take a variable.") };
        s6.dirty = true;
        return { ok: true };
      }
      if (op.op === "promote") {
        // Promote to Variable: a new field (shown in the Inspector) holding the input's value; the input now uses it.
        const f = locate(m, layoutRef.current, String(op.node));
        const pin = String(op.pin);
        if (!f || op.dir !== "in") return { ok: false, error: L("אפשר להפוך למשתנה כניסה של צעד (ערך שהוא מקבל).", "Only a step's input (a value it takes) can be promoted.") };
        const s5 = f.stmt;
        const current = s5.kind === "call" && /^arg\d+$/.test(pin) ? s5.args[Number(pin.slice(3))] : (s5.kind === "set" || s5.kind === "local" || s5.kind === "return") && pin === "value" ? s5.value : s5.kind === "if" && pin === "Condition" ? s5.cond : undefined;
        if (current === undefined) return { ok: false, error: L("לקלט הזה אי אפשר לתת משתנה.", "This input cannot take a variable.") };
        const type = typeOfValue(current ?? "", String(op.type ?? ""));
        const taken = new Set((cls?.fields ?? []).map((x) => x.name));
        const base = s5.kind === "call" ? `${s5.name[0]!.toLowerCase()}${s5.name.slice(1)}${pin.replace("arg", "")}` : s5.kind === "if" ? "condition" : s5.kind === "set" ? `new${s5.target[0]!.toUpperCase()}${s5.target.slice(1)}` : "value";
        let name = base.replace(/[^A-Za-z0-9_]/g, "") || "newVar";
        for (let k = 2; taken.has(name); k++) name = `${base}${k}`;
        if (s5.kind === "call") s5.args[Number(pin.slice(3))] = name;
        else if (s5.kind === "if") s5.cond = name;
        else (s5 as { value?: string }).value = name;
        s5.dirty = true;
        const value = current && current !== name ? current : "";
        setTimeout(() => {
          try {
            const now = writeCSharp(text, classes);
            const c = parseCSharp(now)[ci];
            if (!c) return;
            setText(addField(now, c, { type, name, value, shown: true }));
            toast(L(`נוצר המשתנה ${name} (${type}), מוצג ב-Inspector.`, `Made the variable ${name} (${type}), shown in the Inspector.`));
          } catch (e) {
            toast((e as Error).message);
          }
        }, 0);
        return { ok: true };
      }
      if (op.op === "delete") {
        if (!deleteStep(m, layoutRef.current, String(op.node))) return { ok: false, error: L("את הצומת הזה אי אפשר למחוק (זו נקודת הכניסה של המתודה).", "This node cannot be deleted (it is the method's entry).") };
        saveLayout();
        return { ok: true };
      }
      if (op.op === "disconnect") {
        const pin = String(op.pin);
        const n0 = nodes.find((n) => n.id === op.node);
        const p0 = n0?.pins.find((p) => p.name === pin);
        if (p0?.type === "exec") {
          // Breaking a flow wire: the steps after it leave the code and stay on the graph where they are.
          const next = p0.dir === "in" ? n0 : nodes.find((n) => p0.links?.[0] === `${n.id}:execute`);
          breakExec(m, layoutRef.current, String(op.node), pin, p0.dir, { x: next?.x ?? 0, y: next?.y ?? 0 });
          saveLayout();
          return { ok: true };
        }
        const f = locate(m, layoutRef.current, String(op.node));
        if (!f) return { ok: true };
        const s2 = f.stmt;
        if (s2.kind === "call" && /^arg\d+$/.test(pin)) s2.args[Number(pin.slice(3))] = "0";
        else if ((s2.kind === "set" || s2.kind === "local") && pin === "value") s2.value = "0";
        else if (s2.kind === "if" && pin === "Condition") s2.cond = "true";
        else return { ok: false, error: L("חיבורי זרימה משנים מקום על ידי גרירת חוט חדש.", "Flow wires change by drawing a new wire.") };
        s2.dirty = true;
        return { ok: true };
      }
      if (op.op !== "connect") return { ok: false, error: `${String(op.op)}?` };
      const from = op.from as { node: string; pin: string };
      const to = op.to as { node: string; pin: string };
      const target = locate(m, layoutRef.current, to.node);
      if (!target) return { ok: false, error: L("אי אפשר לחבר לנקודת הכניסה של המתודה.", "Nothing can connect into the method's entry.") };
      const fromNode = nodes.find((n) => n.id === from.node);
      const fromPin = fromNode?.pins.find((p) => p.name === from.pin);
      if (fromPin?.type === "exec") {
        if (to.pin !== "execute") return { ok: false, error: L("חוט זרימה מתחבר לכניסה של צעד.", "A flow wire goes into a step's entry.") };
        // As in Unreal: the step (and the steps after it) moves to the pin; what followed the pin is cut loose.
        const was = fromPin.links?.[0];
        const next = was ? nodes.find((n) => `${n.id}:execute` === was) : undefined;
        const err = wireExec(m, layoutRef.current, from, to.node, { x: next?.x ?? 0, y: (next?.y ?? 0) + 220 });
        if (err) return { ok: false, error: err };
        saveLayout();
        return { ok: true };
      }
      // A value: the method's parameter (or any output with a name) written into the step's input.
      const value = from.node === m.id ? from.pin : fromNode ? `${fromNode.title}.${from.pin}` : from.pin;
      const s4 = target.stmt;
      if (s4.kind === "call" && /^arg\d+$/.test(to.pin)) s4.args[Number(to.pin.slice(3))] = value;
      else if (s4.kind === "call" && to.pin === "Target") s4.target = value;
      else if ((s4.kind === "set" || s4.kind === "local" || s4.kind === "return") && to.pin === "value") s4.value = value;
      else if (s4.kind === "if" && to.pin === "Condition") s4.cond = value;
      else return { ok: false, error: L("לקלט הזה אי אפשר לחבר ערך.", "A value cannot go into this input.") };
      s4.dirty = true;
      return { ok: true };
    });
    if (results.some((r) => r.ok) && ops.some((o) => o.op !== "move")) setTick((t) => t + 1);
    return results;
  };
  /** A fresh statement of the chosen kind (the defaults a person without code expects). */
  const fresh = (kind: "call" | "set" | "if" | "local", target?: string): CsStmt => {
    const id = newId();
    return kind === "call" ? { id, kind, target: "Debug", name: "Log", args: ['"Hello"'], src: "", dirty: true }
      : kind === "set" ? { id, kind, target: target ?? cls?.fields[0]?.name ?? "value", op: "=", value: target ? (cls?.fields.find((f) => f.name === target)?.value ?? "0") : "0", src: "", dirty: true }
      : kind === "local" ? { id, kind, type: "var", name: "x", value: "0", src: "", dirty: true }
      : { id, kind, cond: "true", then: [], src: "", dirty: true };
  };
  /** Adds a new step after the chosen one (or at the end of the method). */
  const add = (kind: "call" | "set" | "if" | "local", target?: string) => {
    if (!m) return;
    const stmt = fresh(kind, target);
    const list = found ? found.list : m.body;
    list.splice(found ? found.index + 1 : list.length, 0, stmt);
    setSel(stmt.id);
    setTick((t) => t + 1);
  };
  /** Adds a new step inside the chosen Branch (True, or False — created when it has none) or Loop. */
  const addInside = (where: "then" | "else" | "body") => {
    if (!st) return;
    const body = st.kind === "loop" ? st.body : st.kind === "if" ? (where === "else" ? (st.else ??= []) : st.then) : undefined;
    if (!body) return;
    const at = body.length;
    insertStep(body, at, fresh("call"));
    setSel(body[at]!.id);
    setTick((t) => t + 1);
  };
  /** Unity compiles the scripts now; this script's errors are marked on their lines. */
  const check = async (quiet = false) => {
    setChecking(true);
    try {
      const r = await api<{ ok: boolean; offline?: boolean; note?: string; errors: Array<CodeProblem & { file: string }> }>("/api/unity/scripts/compile", { method: "POST" });
      const mine = r.errors.filter((e) => e.file.replace(/\\/g, "/").toLowerCase() === path.toLowerCase());
      setProblems(mine);
      if (r.offline) toast(r.note ?? L("Unity לא פתוח, אז הקוד לא קומפל.", "Unity is not open, so nothing was compiled."));
      else if (!r.ok && !r.errors.length) toast(L(`Unity לא הצליח לקמפל: ${r.note ?? "סיבה לא ידועה"}`, `Unity could not compile: ${r.note ?? "unknown reason"}`));
      else if (!quiet || !r.ok) {
        const others = r.errors.filter((e) => e.severity === "error").length - mine.filter((e) => e.severity === "error").length;
        toast(r.ok ? L("✅ מתקמפל בלי שגיאות.", "✅ Compiles with no errors.") : L(`${mine.filter((e) => e.severity === "error").length} שגיאות בסקריפט הזה${others ? `, ${others} בסקריפטים אחרים` : ""}.`, `${mine.filter((e) => e.severity === "error").length} errors in this script${others ? `, ${others} in others` : ""}.`));
      }
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  /** The AI changes the script as asked (or fixes the errors); it is not saved until the user saves. */
  const askAi = async (request: string, fix: boolean, model: string) => {
    const r = await api<{ code: string; note: string }>("/api/unity/script/ai", { method: "POST", body: { path, text: out, request, ...(model ? { model } : {}), ...(fix || problems.length ? { errors: problems } : {}) } });
    if (r.code.trim() === out.trim()) return L("ה-AI לא שינה כלום.", "The AI changed nothing.");
    setBeforeAi(out);
    setText(r.code);
    if (fix) setProblems([]);
    return r.note;
  };
  const save = async () => {
    if (!file) return;
    setSaving(true);
    try {
      await api(`/api/unity/script`, { method: "PUT", body: { path, text: out, mtime: file.mtime } });
      toast(L(`הוחל על ${path.split("/").pop() ?? "הסקריפט"}. Unity מקמפל אותו…`, `Applied to ${path.split("/").pop() ?? "the script"}. Unity is compiling it…`));
      open(path);
      setBeforeAi(null);
      void check(true);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const list = (scripts ?? []).filter((s) => s.toLowerCase().includes(q.toLowerCase())).slice(0, 300);
  const cls = classes[ci] ?? classes[0];
  /** A variable change on the script as it is now (node edits included), then read again. */
  const onVars = (f: (t: string, c: CsClass) => string) => {
    const now = parseCSharp(out)[ci];
    if (!now) throw new Error(L("לא נמצאה מחלקה בסקריפט.", "No class in this script."));
    setText(f(out, now));
  };
  const vars: PanelVar[] = (cls?.fields ?? []).map((f) => ({ name: f.name, type: f.type, value: plainValue(f.type, f.value), shown: f.shown, access: f.access, ...(f.tooltip ? { tooltip: f.tooltip } : {}), ...(f.locked ? { locked: true } : {}) }));
  const spec = (v: PanelVar) => ({ type: v.type, name: v.name, value: csValue(v.type, v.value), shown: v.shown, ...(v.access ? { access: v.access as CsAccess } : {}), ...(v.tooltip ? { tooltip: v.tooltip } : {}) });
  const types: PanelType[] = [
    ...UNITY_TYPES,
    ...[...new Set((scripts ?? []).map((s) => s.split("/").pop()!.replace(/\.cs$/, "")))].filter((n) => /^[A-Za-z_]\w*$/.test(n) && n !== cls?.name).sort().map((n): PanelType => ({ value: n, label: n, input: "none", group: L("הסקריפטים של הפרויקט", "This project's scripts") })),
  ];
  const variables = cls && (
    <VariablesPanel
      vars={vars}
      types={types}
      shownLabel={L("מוצג ב-Inspector", "Shown in the Inspector")}
      access={[
        { value: "public", label: L("Public: סקריפטים אחרים יכולים להשתמש בו", "Public: other scripts can use it") },
        { value: "private", label: L("Private: רק הסקריפט הזה", "Private: this script only") },
        { value: "protected", label: L("Protected: הסקריפט הזה ומי שיורש ממנו", "Protected: this script and ones that inherit it") },
      ]}
      busy={saving}
      actions={{
        add: (v) => onVars((t, c) => addField(t, c, spec(v))),
        change: (name, v) => onVars((t, c) => updateField(t, c, name, spec(v))),
        remove: (name) => onVars((t, c) => removeField(t, c, name)),
        uses: (name) => (cls ? fieldUses(out, parseCSharp(out)[ci] ?? cls, name).length : 0),
        setInGraph: m ? (name) => { setShow("nodes"); add("set", name); } : undefined,
      }}
    />
  );
  return (
    <div className="ue-body script-nodes">
      <aside className="ue-list card">
        <input value={q} placeholder={L("חיפוש סקריפט…", "Find a script…")} onChange={(e) => setQ(e.target.value)} aria-label={L("חיפוש סקריפט", "Find a script")} />
        {/* On a phone the list folds into one menu. */}
        <Select className="ue-select" value={path} onChange={(e) => e.target.value && open(e.target.value)} aria-label={L("סקריפט", "Script")}>
          <option value="">{L("בחרו סקריפט…", "Choose a script…")}</option>
          {(scripts ?? []).map((s) => <option key={s} value={s}>{s.replace(/^Assets\//, "")}</option>)}
        </Select>
        {scripts === null ? <p className="muted small">…</p> : !scripts.length ? (
          <div className="stack small">
            <p className="muted">{searched.error ?? L(`לא נמצאו קבצי .cs בתיקיית Assets (נבדקו ${searched.folders} תיקיות).`, `No .cs files in Assets (${searched.folders} folders looked at).`)}</p>
            <button type="button" onClick={loadScripts}>{L("חפש שוב", "Search again")}</button>
          </div>
        ) : (
          <ul>
            {list.map((s) => (
              <li key={s}><button type="button" className={s === path ? "on" : ""} onClick={() => open(s)} title={s} dir="ltr">{s.split("/").pop()}</button></li>
            ))}
          </ul>
        )}
      </aside>
      <section className="card stack ue-main">
        {!file ? (
          <p className="muted">{L("בחרו סקריפט C# כדי לראות אותו כנודים. אפשר לשנות ערכים, להזיז ולמחוק צעדים בלי לכתוב קוד, ולשמור בחזרה ל-C#.", "Pick a C# script to see it as nodes. Change values, move and remove steps without writing code, then save it back as C#.")}</p>
        ) : (
          <>
            <div className="row wrap">
              <strong className="grow" dir="ltr">{cls ? `${cls.name}${cls.base ? ` : ${cls.base}` : ""}` : path}</strong>
              <span className="row bp-code-lang" role="tablist">
                <button type="button" role="tab" aria-selected={show === "nodes"} className={show === "nodes" ? "on" : ""} onClick={() => setShow("nodes")}>{L("נודים", "Nodes")}</button>
                <button type="button" role="tab" aria-selected={show === "code"} className={show === "code" ? "on" : ""} onClick={() => setShow("code")}>C#</button>
              </span>
              <button type="button" disabled={!changed || saving} onClick={() => open(path)}>{L("בטל שינויים", "Discard changes")}</button>
              <button type="button" className="primary" disabled={!changed || saving} onClick={() => void save()} title={L(`כותב את השינויים לתוך ${path.split("/").pop() ?? ""}: רק המתודות ששונו נכתבות מחדש`, `Writes the changes into ${path.split("/").pop() ?? ""}: only the methods you changed are rewritten`)}>{saving ? "…" : L("✓ החל על הסקריפט", "✓ Apply to the script")}</button>
            </div>
            {classes.length > 1 && (
              <label className="row small">
                <span className="muted">{L("מחלקה", "Class")}</span>
                <Select dir="ltr" value={ci} onChange={(e) => { const i = Number(e.target.value); setCi(i); setMethod(classes[i]?.methods[0]?.id ?? ""); setSel(""); }}>
                  {classes.map((c, i) => <option key={i} value={i}>{c.name}</option>)}
                </Select>
              </label>
            )}
            <div className="row wrap script-methods" role="tablist" aria-label={L("פונקציות", "Methods")}>
              {(cls?.methods ?? []).map((x) => (
                <button key={x.id} type="button" role="tab" aria-selected={x.id === method} className={x.id === method ? "on" : ""} onClick={() => { setMethod(x.id); setSel(""); }} dir="ltr">{x.name}</button>
              ))}
            </div>
            {show === "code" ? (
              <Fullscreen className="script-fs" label={L("הקוד במסך מלא", "The code, full screen")}>
              <div className="script-code-wrap">
                <div className="row wrap script-code-bar">
                  <button type="button" disabled={checking} onClick={() => void check()} title={L("Unity מקמפל את כל הסקריפטים ומסמן את השגיאות בשורות", "Unity compiles every script and the errors are marked on their lines")}>{checking ? L("בודק…", "Checking…") : L("🔎 בדוק קומפילציה", "🔎 Check compile")}</button>
                  <span className="muted small">{L("Ctrl+Space: השלמה · Ctrl+.: תיקון מהיר · F12: הגדרה · F2: שינוי שם · Ctrl+S: שמירה", "Ctrl+Space: suggestions · Ctrl+.: quick fix · F12: definition · F2: rename · Ctrl+S: save")}</span>
                  {lsp && (lsp.installed && lsp.solution ? (
                    <span className={`pill ${lspStatus === "ready" ? "good" : ""}`} title={L("שרת שפה של C# (Roslyn) מכיר את כל הפרויקט והספריות", "A C# language server (Roslyn) that knows the whole project and its libraries")}>{lspStatus === "ready" ? L("🧠 מצב Rider", "🧠 Rider mode") : lspStatus.startsWith("error") ? L("מצב Rider: שגיאה", "Rider mode: error") : L("🧠 מצב Rider נטען…", "🧠 Rider mode loading…")}</span>
                  ) : !lsp.installed ? (
                    <button type="button" disabled={installing || !lsp.dotnet} onClick={() => void installLsp()} title={lsp.dotnet ? L("מתקין את csharp-ls (כלי של .NET למשתמש שלך) להשלמות ושגיאות של כל הפרויקט", "Installs csharp-ls (a .NET tool for your user) for suggestions and errors from the whole project") : L("צריך .NET SDK 8 ומעלה (dot.net)", "Needs the .NET SDK 8 or newer (dot.net)")}>{installing ? L("מתקין…", "Installing…") : L("🧠 התקן מצב Rider", "🧠 Install Rider mode")}</button>
                  ) : (
                    <span className="muted small">{L("למצב Rider: ב-Unity, Preferences → External Tools → Regenerate project files", "For Rider mode: in Unity, Preferences → External Tools → Regenerate project files")}</span>
                  ))}
                </div>
                <Suspense fallback={<p className="muted">…</p>}>
                  <CodeEditor path={path} {...(lsp?.project ? { fullPath: `${lsp.project}/${path}` } : {})} value={out} onChange={setText} language="csharp" problems={problems} {...(lsp?.installed && lsp.solution && lsp.project ? { lsp: { url: "/api/unity/lsp", root: lsp.project, file: `${lsp.project}/${path}`, onStatus: setLspStatus } } : {})} projectTypes={types.filter((t) => t.group !== "Unity" && t.input === "none").map((t) => t.value)} onSave={() => changed && void save()} />
                </Suspense>
                {problems.length > 0 && (
                  <ul className="code-problems">
                    {problems.map((e, i) => <li key={i} className={e.severity} dir="ltr"><span className="mono">{e.line}:{e.column}</span> {e.code} {e.message}</li>)}
                  </ul>
                )}
                <CodeAiBubble ask={askAi} errors={problems.filter((e) => e.severity === "error").length} canUndo={beforeAi !== null} onUndo={() => { if (beforeAi !== null) { setText(beforeAi); setBeforeAi(null); } }} placeholder={L("למשל: תוסיף קפיצה עם רווח", "e.g. add a jump on Space")} />
              </div>
              </Fullscreen>
            ) : (
              <Fullscreen className="script-fs" label={L("הסקריפט במסך מלא", "The script, full screen")}>
              <div
                className="script-graph"
                onKeyDown={(e) => {
                  // Ctrl+PageUp / Ctrl+PageDown: the previous / next method's graph (as tabs in Visual Studio and VS Code).
                  if (!(e.ctrlKey || e.metaKey) || (e.key !== "PageUp" && e.key !== "PageDown")) return;
                  const list = cls?.methods ?? [];
                  const at = list.findIndex((x) => x.id === method);
                  const next = list[(at + (e.key === "PageDown" ? 1 : -1) + list.length) % list.length];
                  if (!next || next.id === method) return;
                  e.preventDefault();
                  setMethod(next.id);
                  setSel("");
                }}
              >
                <div className="script-canvas">
                  <CodeAiBubble ask={askAi} errors={problems.filter((e) => e.severity === "error").length} canUndo={beforeAi !== null} onUndo={() => { if (beforeAi !== null) { setText(beforeAi); setBeforeAi(null); } }} placeholder={L("למשל: כשהשחקן נוגע במטבע תוסיף נקודה", "e.g. when the player touches a coin add a point")} />
                  {m && <BlueprintCanvas key={`${ci}:${m.name}`} nodes={drawn} path={path} graph={m.name} editable unity onOps={graphOps} localActions={localActions} onChanged={() => undefined} onSelect={(ids) => setSel([...ids][0] ?? "")} />}
                </div>
                <div className="script-side">
                <aside className="script-vars card">{variables}</aside>
                <aside className="script-edit card">
                  <div className="row wrap script-add" aria-label={L("הוספת צעד", "Add a step")}>
                    <span className="muted small">{st ? L("הוסף אחרי:", "Add after:") : L("הוסף בסוף:", "Add at the end:")}</span>
                    <button type="button" onClick={() => add("call")}>+ {L("פעולה", "Action")}</button>
                    <button type="button" onClick={() => add("set")}>+ {L("שינוי ערך", "Change a value")}</button>
                    <button type="button" onClick={() => add("if")}>+ {L("תנאי", "Condition")}</button>
                    <button type="button" onClick={() => add("local")}>+ {L("משתנה", "Variable")}</button>
                  </div>
                  {st && (st.kind === "if" || st.kind === "loop") && (
                    <div className="row wrap script-add" aria-label={L("הוספה בפנים", "Add inside")}>
                      <span className="muted small">{st.kind === "loop" ? L("הוסף בפנים הלולאה:", "Add inside the loop:") : L("הוסף בתנאי:", "Add inside the condition:")}</span>
                      <button type="button" onClick={() => addInside("then")}>+ {st.kind === "loop" ? L("בלולאה", "In the loop") : L("כשהתנאי נכון", "When true")}</button>
                      {st.kind === "if" && <button type="button" onClick={() => addInside("else")}>+ {L("אחרת", "Otherwise")}</button>}
                    </div>
                  )}
                  {!st ? (
                    <p className="muted small">{L("בחרו נוד כדי לשנות אותו.", "Choose a node to change it.")}</p>
                  ) : (
                    <>
                      <strong>{L(...KIND[st.kind])}</strong>
                      {st.kind === "if" && <Field label={L("התנאי", "Condition")} value={st.cond} onChange={(v) => edit((s) => s.kind === "if" && (s.cond = v))} />}
                      {st.kind === "loop" && <Field label={L("חוזר על", "Repeats")} value={st.head} onChange={(v) => edit((s) => s.kind === "loop" && (s.head = v))} />}
                      {st.kind === "call" && (
                        <>
                          <Field label={L("על מה (אפשר להשאיר ריק)", "On what (can be empty)")} value={st.target} onChange={(v) => edit((s) => s.kind === "call" && (s.target = v))} />
                          <Field label={L("הפעולה", "The action")} value={st.name} onChange={(v) => edit((s) => s.kind === "call" && (s.name = v.replace(/[^\w]/g, "")))} />
                          <button type="button" className="small" onClick={() => edit((s) => s.kind === "call" && s.args.push("0"))}>+ {L("קלט", "Input")}</button>
                          {st.args.map((a, i) => <Field key={i} label={`${L("קלט", "Input")} ${i + 1}`} value={a} onChange={(v) => edit((s) => s.kind === "call" && (s.args[i] = v))} />)}
                        </>
                      )}
                      {st.kind === "set" && (
                        <>
                          <Field label={L("מה משתנה", "What changes")} value={st.target} onChange={(v) => edit((s) => s.kind === "set" && (s.target = v))} />
                          <Field label={`${L("ערך חדש", "New value")} (${st.op})`} value={st.value} onChange={(v) => edit((s) => s.kind === "set" && (s.value = v))} />
                        </>
                      )}
                      {st.kind === "local" && (
                        <>
                          <Field label={L("סוג", "Type")} value={st.type} onChange={(v) => edit((s) => s.kind === "local" && (s.type = v))} />
                          <Field label={L("שם", "Name")} value={st.name} onChange={(v) => edit((s) => s.kind === "local" && (s.name = v.replace(/[^\w]/g, "")))} />
                          <Field label={L("ערך", "Value")} value={st.value} onChange={(v) => edit((s) => s.kind === "local" && (s.value = v))} />
                        </>
                      )}
                      {st.kind === "return" && <Field label={L("מחזיר", "Returns")} value={st.value} onChange={(v) => edit((s) => s.kind === "return" && (s.value = v))} />}
                      {st.kind === "code" && <Field label={L("הקוד", "The code")} value={st.src} multiline onChange={(v) => edit((s) => s.kind === "code" && (s.src = v))} />}
                      <div className="row wrap">
                        <button type="button" onClick={() => move(-1)} disabled={!found || found.index === 0} title={L("הזז למעלה", "Move up")}>↑</button>
                        <button type="button" onClick={() => move(1)} disabled={!found || found.index >= found.list.length - 1} title={L("הזז למטה", "Move down")}>↓</button>
                        <button type="button" onClick={remove} title={L("מחק את הצעד", "Remove this step")}>🗑 {L("מחק", "Remove")}</button>
                      </div>
                    </>
                  )}
                </aside>
                </div>
              </div>
              </Fullscreen>
            )}
            <p className="muted small">{L("רק פונקציות ששיניתם נכתבות מחדש; כל השאר נשאר בדיוק כמו שהיה. לפני כל שמירה נשמר עותק של הקובץ הקודם בתיקייה של KesherAI.", "Only methods you changed are rewritten; everything else stays exactly as it was. A copy of the old file is kept in KesherAI's folder before each save.")}</p>
          </>
        )}
      </section>
    </div>
  );
}

/** One editable value of a node. */
function Field(p: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean }) {
  return (
    <label className="stack small">
      <span className="muted" dir="ltr">{p.label}</span>
      {p.multiline ? (
        <textarea dir="ltr" rows={5} spellCheck={false} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
      ) : (
        <input dir="ltr" spellCheck={false} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
      )}
    </label>
  );
}
