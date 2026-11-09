import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { addField, csValue, fieldUses, findStmt, methodToNodes, parseCSharp, plainValue, removeField, updateField, writeCSharp, type CsAccess, type CsClass, type CsStmt } from "@kesher/shared";
import { api } from "./api";
import { BlueprintCanvas } from "./BlueprintCanvas";
import { Fullscreen } from "./Fullscreen";
import { CodeAiBubble } from "./CodeAiBubble";
import type { CodeProblem } from "./ide/CodeEditor";
// The code editor (VS Code's) is big: loaded when the C# tab first opens.
const CodeEditor = lazy(() => import("./ide/CodeEditor"));
import { VariablesPanel, type PanelType, type PanelVar } from "./VariablesPanel";
import { getLocale } from "./i18n";
import { toast } from "./library";

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
  const [saving, setSaving] = useState(false);
  /** Unity's compile errors for this script (file, line, column), and whether a check is running. */
  const [problems, setProblems] = useState<Array<CodeProblem & { file: string }>>([]);
  const [checking, setChecking] = useState(false);
  /** The script before the AI's last change (one click puts it back). */
  const [beforeAi, setBeforeAi] = useState<string | null>(null);

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
  const nodes = useMemo(() => (m ? methodToNodes(m) : []), [m, tick]);
  const out = useMemo(() => (file ? writeCSharp(text, classes) : ""), [file, text, classes, tick]);
  const changed = !!file && out !== file.text;
  const found = m && sel ? findStmt(m.body, sel) : undefined;
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
  /** Adds a new step after the chosen one (or at the end of the method). */
  const add = (kind: "call" | "set" | "if" | "local", target?: string) => {
    if (!m) return;
    const id = `n${Date.now()}`;
    const stmt: CsStmt =
      kind === "call" ? { id, kind, target: "Debug", name: "Log", args: ['"Hello"'], src: "", dirty: true }
      : kind === "set" ? { id, kind, target: target ?? cls?.fields[0]?.name ?? "value", op: "=", value: target ? (cls?.fields.find((f) => f.name === target)?.value ?? "0") : "0", src: "", dirty: true }
      : kind === "local" ? { id, kind, type: "var", name: "x", value: "0", src: "", dirty: true }
      : { id, kind, cond: "true", then: [], src: "", dirty: true };
    const list = found ? found.list : m.body;
    list.splice(found ? found.index + 1 : list.length, 0, stmt);
    setSel(id);
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
  const askAi = async (request: string, fix: boolean) => {
    const r = await api<{ code: string; note: string }>("/api/unity/script/ai", { method: "POST", body: { path, text: out, request, ...(fix || problems.length ? { errors: problems } : {}) } });
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
      toast(L("נשמר. Unity מקמפל את הסקריפט…", "Saved. Unity is compiling the script…"));
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
        <select className="ue-select" value={path} onChange={(e) => e.target.value && open(e.target.value)} aria-label={L("סקריפט", "Script")}>
          <option value="">{L("בחרו סקריפט…", "Choose a script…")}</option>
          {(scripts ?? []).map((s) => <option key={s} value={s}>{s.replace(/^Assets\//, "")}</option>)}
        </select>
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
              <button type="button" className="primary" disabled={!changed || saving} onClick={() => void save()}>{saving ? "…" : L("💾 שמור ל-C#", "💾 Save as C#")}</button>
            </div>
            {classes.length > 1 && (
              <label className="row small">
                <span className="muted">{L("מחלקה", "Class")}</span>
                <select dir="ltr" value={ci} onChange={(e) => { const i = Number(e.target.value); setCi(i); setMethod(classes[i]?.methods[0]?.id ?? ""); setSel(""); }}>
                  {classes.map((c, i) => <option key={i} value={i}>{c.name}</option>)}
                </select>
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
                  <span className="muted small">{L("Ctrl+Space: השלמה · Ctrl+.: תיקון מהיר · Ctrl+S: שמירה", "Ctrl+Space: suggestions · Ctrl+.: quick fix · Ctrl+S: save")}</span>
                </div>
                <Suspense fallback={<p className="muted">…</p>}>
                  <CodeEditor path={path} value={out} onChange={setText} language="csharp" problems={problems} projectTypes={types.filter((t) => t.group !== "Unity" && t.input === "none").map((t) => t.value)} onSave={() => changed && void save()} />
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
              <div className="script-graph">
                <div className="script-canvas">
                  <CodeAiBubble ask={askAi} errors={problems.filter((e) => e.severity === "error").length} canUndo={beforeAi !== null} onUndo={() => { if (beforeAi !== null) { setText(beforeAi); setBeforeAi(null); } }} placeholder={L("למשל: כשהשחקן נוגע במטבע תוסיף נקודה", "e.g. when the player touches a coin add a point")} />
                  {m && <BlueprintCanvas key={method} nodes={nodes} path={path} graph={m.name} editable={false} unity onChanged={() => undefined} onSelect={(ids) => setSel([...ids][0] ?? "")} />}
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
