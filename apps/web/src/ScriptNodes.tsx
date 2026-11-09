import { useEffect, useMemo, useState } from "react";
import { findStmt, methodToNodes, parseCSharp, writeCSharp, type CsClass, type CsStmt } from "@kesher/shared";
import { api } from "./api";
import { BlueprintCanvas } from "./BlueprintCanvas";
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

/**
 * A Unity C# script as nodes, for people who do not write code: pick a
 * script, pick a method (Start, Update, OnTriggerEnter…), see it as a graph,
 * change a node's values in the panel (a condition, an action's inputs, a new
 * value), remove or move a step, and write it back as C#. Only the methods
 * that changed are rewritten; the rest of the file stays exactly as it was.
 */
export function ScriptNodes() {
  const [scripts, setScripts] = useState<string[] | null>(null);
  const [q, setQ] = useState("");
  const [path, setPath] = useState("");
  const [file, setFile] = useState<{ text: string; mtime: number } | null>(null);
  const [classes, setClasses] = useState<CsClass[]>([]);
  const [method, setMethod] = useState("");
  const [sel, setSel] = useState("");
  const [show, setShow] = useState<"nodes" | "code">("nodes");
  const [tick, setTick] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api<{ scripts: string[] }>("/api/unity/scripts").then((r) => setScripts(r.scripts), (e: Error) => { toast(e.message); setScripts([]); });
  }, []);

  const open = (p: string) => {
    setPath(p);
    setSel("");
    void api<{ text: string; mtime: number }>(`/api/unity/script?path=${encodeURIComponent(p)}`).then((r) => {
      setFile(r);
      const parsed = parseCSharp(r.text);
      setClasses(parsed);
      setMethod(parsed[0]?.methods[0]?.id ?? "");
    }, (e: Error) => toast(e.message));
  };

  const m = classes.flatMap((c) => c.methods).find((x) => x.id === method);
  const nodes = useMemo(() => (m ? methodToNodes(m) : []), [m, tick]);
  const out = useMemo(() => (file ? writeCSharp(file.text, classes) : ""), [file, classes, tick]);
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
  const save = async () => {
    if (!file) return;
    setSaving(true);
    try {
      await api(`/api/unity/script`, { method: "PUT", body: { path, text: out, mtime: file.mtime } });
      toast(L("נשמר. Unity מקמפל את הסקריפט.", "Saved. Unity is compiling the script."));
      open(path);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const list = (scripts ?? []).filter((s) => s.toLowerCase().includes(q.toLowerCase())).slice(0, 300);
  const cls = classes[0];
  return (
    <div className="ue-body script-nodes">
      <aside className="ue-list card">
        <input value={q} placeholder={L("חיפוש סקריפט…", "Find a script…")} onChange={(e) => setQ(e.target.value)} aria-label={L("חיפוש סקריפט", "Find a script")} />
        {/* On a phone the list folds into one menu. */}
        <select className="ue-select" value={path} onChange={(e) => e.target.value && open(e.target.value)} aria-label={L("סקריפט", "Script")}>
          <option value="">{L("בחרו סקריפט…", "Choose a script…")}</option>
          {(scripts ?? []).map((s) => <option key={s} value={s}>{s.replace(/^Assets\//, "")}</option>)}
        </select>
        {scripts === null ? <p className="muted small">…</p> : !scripts.length ? <p className="muted small">{L("אין סקריפטים ב-Assets.", "No scripts in Assets.")}</p> : (
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
            {cls && cls.fields.length > 0 && (
              <p className="small muted" dir="ltr">{L("משתנים:", "Variables:")} {cls.fields.map((f) => `${f.shown ? "◆" : "◇"} ${f.type} ${f.name}${f.value ? ` = ${f.value}` : ""}`).join(" · ")}</p>
            )}
            <div className="row wrap script-methods" role="tablist" aria-label={L("פונקציות", "Methods")}>
              {classes.flatMap((c) => c.methods).map((x) => (
                <button key={x.id} type="button" role="tab" aria-selected={x.id === method} className={x.id === method ? "on" : ""} onClick={() => { setMethod(x.id); setSel(""); }} dir="ltr">{x.name}</button>
              ))}
            </div>
            {show === "code" ? (
              <pre className="bp-code-ai" dir="ltr">{out}</pre>
            ) : (
              <div className="script-graph">
                <div className="script-canvas">
                  {m && <BlueprintCanvas key={method} nodes={nodes} path={path} graph={m.name} editable={false} unity onChanged={() => undefined} onSelect={(ids) => setSel([...ids][0] ?? "")} />}
                </div>
                <aside className="script-edit card">
                  {!st ? (
                    <p className="muted small">{L("בחרו נוד כדי לשנות אותו.", "Choose a node to change it.")}</p>
                  ) : (
                    <>
                      <strong>{L(...KIND[st.kind])}</strong>
                      {st.kind === "if" && <Field label={L("התנאי", "Condition")} value={st.cond} onChange={(v) => edit((s) => s.kind === "if" && (s.cond = v))} />}
                      {st.kind === "loop" && <Field label={L("חוזר על", "Repeats")} value={st.head} onChange={(v) => edit((s) => s.kind === "loop" && (s.head = v))} />}
                      {st.kind === "call" && (
                        <>
                          <p className="small" dir="ltr">{st.target ? `${st.target}.` : ""}{st.name}( )</p>
                          {st.args.map((a, i) => <Field key={i} label={`${L("קלט", "Input")} ${i + 1}`} value={a} onChange={(v) => edit((s) => s.kind === "call" && (s.args[i] = v))} />)}
                        </>
                      )}
                      {st.kind === "set" && <Field label={`${st.target} ${st.op}`} value={st.value} onChange={(v) => edit((s) => s.kind === "set" && (s.value = v))} />}
                      {st.kind === "local" && <Field label={`${st.type} ${st.name} =`} value={st.value} onChange={(v) => edit((s) => s.kind === "local" && (s.value = v))} />}
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
