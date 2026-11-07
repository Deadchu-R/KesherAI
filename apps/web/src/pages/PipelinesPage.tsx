import { useEffect, useState } from "react";
import { api, withToken } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";
import { usePersonas } from "../Personas";
import { RoutinesSection } from "../Routines";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

type Test = { kind: "contains" | "equals" | "regex" | "ask" | "empty"; text: string; value?: string; not?: boolean };
type Step = { id: string; type: string; [k: string]: unknown };
interface Pipeline { id?: string; name: string; description?: string; inputs: Array<{ name: string; label?: string; long?: boolean }>; steps: Step[] }
interface Run { id: string; name: string; status: "running" | "done" | "error" | "stopped"; startedAt: string; endedAt?: string; vars?: Record<string, string>; log?: Array<{ at: string; step: string; type: string; text: string }>; files: string[]; error?: string; last?: string }

const TYPES: Array<[string, string, string]> = [
  ["ask", "שאלה למודל", "Ask a model"],
  ["if", "תנאי", "If"],
  ["loop", "לולאה", "Loop"],
  ["knowledge", "חיפוש בידע", "Search knowledge"],
  ["image", "יצירת תמונה", "Make an image"],
  ["transcribe", "תמלול", "Transcribe"],
  ["set", "משתנה", "Set a variable"],
  ["save", "שמירה לקובץ", "Save to a file"],
  ["notify", "התראה", "Notify"],
  ["break", "יציאה מהלולאה", "Leave the loop"],
];
const typeName = (t: string) => {
  const x = TYPES.find((y) => y[0] === t);
  return x ? L(x[1], x[2]) : t;
};
const HE_TEMPLATES: Record<string, [string, string]> = {
  "Write, review, improve": ["כתיבה, ביקורת ושיפור", "מודל כותב, מבקר בודק, והטקסט נכתב מחדש עד שהמבקר מאשר (עד 4 סבבים)."],
  "Meeting recording → notes and emails": ["הקלטת פגישה ← סיכום ומיילים", "מתמלל הקלטה, כותב סיכום, ואז מייל קצר לכל משימה."],
  "Translate line by line": ["תרגום שורה אחרי שורה", "מתרגם כל שורה בנפרד (טוב לכתוביות ולטקסטים של ממשק)."],
  "Ideas → pictures": ["רעיונות ← תמונות", "מעלה רעיונות לתמונות על נושא, ויוצר תמונה לכל אחד."],
};
const localTemplate = (p: Pipeline): Pipeline => (getLocale() === "he" && HE_TEMPLATES[p.name] ? { ...p, name: HE_TEMPLATES[p.name]![0], description: HE_TEMPLATES[p.name]![1] } : p);
let seq = 0;
const newStep = (type: string): Step => {
  const id = `s${Date.now().toString(36)}${seq++}`;
  switch (type) {
    case "ask": return { id, type, prompt: "", output: "answer" };
    case "if": return { id, type, test: { kind: "contains", text: "{{answer}}", value: "" }, then: [], else: [] };
    case "loop": return { id, type, mode: "lines", over: "{{answer}}", max: 20, steps: [] };
    case "knowledge": return { id, type, query: "", output: "found" };
    case "image": return { id, type, prompt: "", output: "picture" };
    case "transcribe": return { id, type, path: "", output: "transcript" };
    case "set": return { id, type, value: "", output: "text" };
    case "save": return { id, type, file: "result.txt", content: "{{answer}}" };
    case "notify": return { id, type, message: "" };
    default: return { id, type };
  }
};

function TestEditor({ t, onChange }: { t: Test; onChange: (t: Test) => void }) {
  return (
    <div className="row pl-test">
      <input value={t.text} onChange={(e) => onChange({ ...t, text: e.target.value })} placeholder="{{answer}}" dir="auto" />
      <select value={`${t.not ? "!" : ""}${t.kind}`} onChange={(e) => onChange({ ...t, not: e.target.value.startsWith("!"), kind: e.target.value.replace("!", "") as Test["kind"] })}>
        <option value="contains">{L("מכיל", "contains")}</option>
        <option value="!contains">{L("לא מכיל", "does not contain")}</option>
        <option value="equals">{L("שווה ל", "equals")}</option>
        <option value="regex">{L("מתאים לביטוי", "matches regex")}</option>
        <option value="empty">{L("ריק", "is empty")}</option>
        <option value="!empty">{L("לא ריק", "is not empty")}</option>
        <option value="ask">{L("לפי המודל: כן", "model says yes to")}</option>
        <option value="!ask">{L("לפי המודל: לא", "model says no to")}</option>
      </select>
      {t.kind !== "empty" && <input className="grow" value={t.value ?? ""} onChange={(e) => onChange({ ...t, value: e.target.value })} placeholder={t.kind === "ask" ? L("השאלה, למשל: האם זה מאושר?", "The question, e.g. Is it approved?") : L("מה לחפש", "What to look for")} dir="auto" />}
    </div>
  );
}

function Steps({ steps, onChange, depth, inLoop }: { steps: Step[]; onChange: (s: Step[]) => void; depth: number; inLoop: boolean }) {
  const personas = usePersonas();
  const set = (i: number, s: Step) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, d: number) => {
    const n = [...steps];
    const [x] = n.splice(i, 1);
    n.splice(Math.max(0, Math.min(n.length, i + d)), 0, x!);
    onChange(n);
  };
  const field = (s: Step, i: number, k: string, label: string, long = false, ltr = false) =>
    long ? (
      <label className="pl-field">{label}<textarea rows={3} dir="auto" value={String(s[k] ?? "")} onChange={(e) => set(i, { ...s, [k]: e.target.value })} /></label>
    ) : (
      <label className="pl-field">{label}<input dir={ltr ? "ltr" : "auto"} value={String(s[k] ?? "")} onChange={(e) => set(i, { ...s, [k]: e.target.value })} /></label>
    );
  const out = (s: Step, i: number) => (
    <label className="pl-field pl-out">{L("שם התוצאה", "Result name")}<input dir="ltr" value={String(s.output ?? "")} onChange={(e) => set(i, { ...s, output: e.target.value.replace(/[^\p{L}\p{N}_-]/gu, "") })} /></label>
  );
  return (
    <ol className={`pl-steps depth-${depth}`}>
      {steps.map((s, i) => (
        <li key={s.id} className={`pl-step t-${s.type}`}>
          <div className="row pl-step-head">
            <strong>{typeName(s.type)}</strong>
            {"output" in s && <code dir="ltr">{`{{${String(s.output)}}}`}</code>}
            <span className="grow" />
            <button type="button" className="as-link" onClick={() => move(i, -1)} disabled={i === 0} aria-label={L("למעלה", "Up")}>↑</button>
            <button type="button" className="as-link" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={L("למטה", "Down")}>↓</button>
            <button type="button" className="as-link" onClick={() => onChange(steps.filter((_, j) => j !== i))} aria-label={L("מחיקה", "Delete")}>✕</button>
          </div>
          {s.type === "ask" && (
            <>
              {field(s, i, "prompt", L("מה לשאול", "What to ask"), true)}
              <div className="row">
                {out(s, i)}
                {personas.length > 0 && (
                  <label className="pl-field">{L("פרסונה", "Persona")}
                    <select value={String(s.persona ?? "")} onChange={(e) => set(i, { ...s, persona: e.target.value || undefined })}>
                      <option value="">{L("ללא", "None")}</option>
                      {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>
                )}
                {field(s, i, "model", L("מודל (ריק = הפעיל)", "Model (empty = active)"), false, true)}
              </div>
            </>
          )}
          {s.type === "knowledge" && <div className="row">{field(s, i, "query", L("מה לחפש", "What to search for"))}{field(s, i, "base", L("מאגר (ריק = הכול)", "Base (empty = all)"))}{out(s, i)}</div>}
          {s.type === "image" && <div className="row">{field(s, i, "prompt", L("תיאור התמונה", "Picture description"))}{out(s, i)}</div>}
          {s.type === "transcribe" && <div className="row">{field(s, i, "path", L("נתיב הקובץ", "File path"), false, true)}{out(s, i)}</div>}
          {s.type === "set" && <div className="row">{field(s, i, "value", L("ערך", "Value"), true)}{out(s, i)}</div>}
          {s.type === "save" && <div className="row">{field(s, i, "file", L("שם הקובץ", "File name"), false, true)}{field(s, i, "content", L("תוכן", "Content"), true)}</div>}
          {s.type === "notify" && field(s, i, "message", L("ההודעה", "Message"))}
          {s.type === "break" && !inLoop && <p className="error small">{L("עובד רק בתוך לולאה.", "Only works inside a loop.")}</p>}
          {s.type === "if" && (
            <>
              <TestEditor t={s.test as Test} onChange={(t) => set(i, { ...s, test: t })} />
              <div className="pl-branch"><span className="muted small">{L("אם כן:", "Then:")}</span><Steps steps={(s.then as Step[]) ?? []} onChange={(n) => set(i, { ...s, then: n })} depth={depth + 1} inLoop={inLoop} /></div>
              <div className="pl-branch"><span className="muted small">{L("אחרת:", "Else:")}</span><Steps steps={(s.else as Step[]) ?? []} onChange={(n) => set(i, { ...s, else: n })} depth={depth + 1} inLoop={inLoop} /></div>
            </>
          )}
          {s.type === "loop" && (
            <>
              <div className="row">
                <label className="pl-field">{L("סוג", "Kind")}
                  <select value={String(s.mode)} onChange={(e) => set(i, { ...s, mode: e.target.value, ...(e.target.value === "until" && !s.until ? { until: { kind: "contains", text: "{{answer}}", value: "" } } : {}) })}>
                    <option value="lines">{L("לכל שורה ב…", "For each line of…")}</option>
                    <option value="times">{L("מספר פעמים", "A number of times")}</option>
                    <option value="until">{L("עד ש…", "Until…")}</option>
                  </select>
                </label>
                {s.mode === "lines" && field(s, i, "over", L("הטקסט ({{item}} = השורה)", "The text ({{item}} = the line)"))}
                {s.mode === "times" && <label className="pl-field">{L("כמה פעמים", "How many")}<input type="number" min={1} max={500} value={Number(s.count ?? 3)} onChange={(e) => set(i, { ...s, count: Number(e.target.value) })} /></label>}
                <label className="pl-field">{L("לכל היותר", "At most")}<input type="number" min={1} max={500} value={Number(s.max ?? 20)} onChange={(e) => set(i, { ...s, max: Number(e.target.value) })} /></label>
              </div>
              {s.mode === "until" && <TestEditor t={s.until as Test} onChange={(t) => set(i, { ...s, until: t })} />}
              <div className="pl-branch"><span className="muted small">{L("בכל סיבוב ({{index}} = מספר הסיבוב):", "Each round ({{index}} = the round):")}</span><Steps steps={(s.steps as Step[]) ?? []} onChange={(n) => set(i, { ...s, steps: n })} depth={depth + 1} inLoop /></div>
            </>
          )}
        </li>
      ))}
      <li className="pl-add">
        <select value="" onChange={(e) => e.target.value && onChange([...steps, newStep(e.target.value)])} aria-label={L("הוספת צעד", "Add a step")}>
          <option value="">{L("+ הוספת צעד…", "+ Add a step…")}</option>
          {TYPES.filter(([t]) => t !== "break" || inLoop).map(([t]) => <option key={t} value={t}>{typeName(t)}</option>)}
        </select>
      </li>
    </ol>
  );
}

function RunView({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => api<Run>(`/api/pipelines/runs/${runId}`).then((r) => { if (!alive) return; setRun(r); if (r.status === "running") setTimeout(tick, 1000); }, () => undefined);
    void tick();
    return () => void (alive = false);
  }, [runId]);
  if (!run) return null;
  const file = (f: string) => withToken(`/api/pipelines/runs/${run.id}/files/${encodeURIComponent(f)}`);
  return (
    <section className="card stack pl-run">
      <div className="row">
        <strong>{run.name}</strong>
        <span className={`pill ${run.status === "done" ? "good" : run.status === "error" ? "bad" : ""}`}>{{ running: L("רץ…", "Running…"), done: L("הסתיים", "Done"), error: L("שגיאה", "Error"), stopped: L("נעצר", "Stopped") }[run.status]}</span>
        <span className="grow" />
        {run.status === "running" && <button type="button" onClick={() => void api(`/api/pipelines/runs/${run.id}/stop`, { method: "POST" })}>■ {L("עצירה", "Stop")}</button>}
        <button type="button" className="as-link" onClick={onClose}>{L("סגירה", "Close")}</button>
      </div>
      {run.error && <p className="error">{run.error}</p>}
      {run.files.length > 0 && (
        <div className="pl-files">
          {run.files.map((f) => (/\.(png|jpe?g|webp)$/i.test(f) ? <a key={f} href={file(f)} target="_blank" rel="noreferrer"><img src={file(f)} alt={f} /></a> : <a key={f} className="pill" href={file(f)} target="_blank" rel="noreferrer" dir="ltr">📄 {f}</a>))}
        </div>
      )}
      <ol className="pl-log">
        {(run.log ?? []).map((l, i) => (
          <li key={i} className={l.type === "error" ? "bad" : ""}>
            <span className="muted small">{new Date(l.at).toLocaleTimeString(getLocale() === "he" ? "he-IL" : undefined)}</span> <span className="muted small">{typeName(l.type)}</span>
            <div className="pl-log-text" dir="auto">{l.text}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Pipelines: chains of models and tools with conditions and loops, run in the background. */
export function PipelinesPage() {
  const [list, setList] = useState<Pipeline[]>([]);
  const [templates, setTemplates] = useState<Pipeline[]>([]);
  const [edit, setEdit] = useState<Pipeline | null>(null);
  const [json, setJson] = useState<string | null>(null);
  const [runFor, setRunFor] = useState<Pipeline | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [runId, setRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const load = () => {
    api<{ pipelines: Pipeline[]; templates: Pipeline[] }>("/api/pipelines").then((r) => { setList(r.pipelines); setTemplates(r.templates); }, (e: Error) => toast(e.message));
    api<Run[]>("/api/pipelines/runs").then(setRuns, () => undefined);
  };
  useEffect(load, []);
  const save = async (p: Pipeline) => {
    try {
      const saved = await api<Pipeline>("/api/pipelines", { method: "POST", body: p });
      setEdit(null);
      setJson(null);
      load();
      return saved;
    } catch (e) {
      toast((e as Error).message);
      return undefined;
    }
  };
  const start = async (p: Pipeline) => {
    try {
      const r = await api<Run>(`/api/pipelines/${p.id}/run`, { method: "POST", body: { inputs } });
      setRunFor(null);
      setRunId(r.id);
      setTimeout(load, 500);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  if (edit) {
    return (
      <div className="page pipelines">
        <div className="row">
          <h1 className="grow">{edit.id ? L("עריכת צינור", "Edit pipeline") : L("צינור חדש", "New pipeline")}</h1>
          <button type="button" className="as-link" onClick={() => setJson(json === null ? JSON.stringify({ ...edit, id: undefined }, null, 2) : null)}>{json === null ? "JSON" : L("עורך", "Editor")}</button>
        </div>
        {json !== null ? (
          <textarea className="pl-json" dir="ltr" rows={24} value={json} onChange={(e) => setJson(e.target.value)} />
        ) : (
          <>
            <label className="pl-field">{L("שם", "Name")}<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></label>
            <label className="pl-field">{L("תיאור", "Description")}<input value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
            <div className="card stack">
              <strong>{L("קלט (מה ממלאים לפני הרצה)", "Inputs (filled in before each run)")}</strong>
              {edit.inputs.map((inp, i) => (
                <div key={i} className="row">
                  <input dir="ltr" value={inp.name} placeholder="name" onChange={(e) => setEdit({ ...edit, inputs: edit.inputs.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^\p{L}\p{N}_-]/gu, "") } : x)) })} />
                  <input className="grow" value={inp.label ?? ""} placeholder={L("תווית", "Label")} onChange={(e) => setEdit({ ...edit, inputs: edit.inputs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                  <label className="check"><input type="checkbox" checked={!!inp.long} onChange={(e) => setEdit({ ...edit, inputs: edit.inputs.map((x, j) => (j === i ? { ...x, long: e.target.checked } : x)) })} /> {L("ארוך", "Long")}</label>
                  <button type="button" className="as-link" onClick={() => setEdit({ ...edit, inputs: edit.inputs.filter((_, j) => j !== i) })}>✕</button>
                </div>
              ))}
              <div className="row"><button type="button" onClick={() => setEdit({ ...edit, inputs: [...edit.inputs, { name: `input${edit.inputs.length + 1}` }] })}>{L("+ קלט", "+ Input")}</button><span className="muted small">{L("בצעדים כותבים {{name}} כדי להשתמש בערך.", "Write {{name}} in steps to use the value.")}</span></div>
            </div>
            <Steps steps={edit.steps} onChange={(steps) => setEdit({ ...edit, steps })} depth={0} inLoop={false} />
          </>
        )}
        <div className="row">
          <button
            type="button"
            className="primary"
            onClick={() => {
              if (json === null) return void save(edit);
              try {
                void save({ ...(JSON.parse(json) as Pipeline), ...(edit.id ? { id: edit.id } : {}) });
              } catch (e) {
                toast((e as Error).message);
              }
            }}
          >{L("שמירה", "Save")}</button>
          <button type="button" onClick={() => { setEdit(null); setJson(null); }}>{L("ביטול", "Cancel")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page pipelines">
      <div className="page-head">
        <h1>{L("צינורות עבודה", "Pipelines")}</h1>
        <p className="muted">{L("משימות של כמה צעדים שרצות ברקע: מודלים, ידע, תמונות ותמלול — עם תנאים ולולאות. למשל: לתמלל פגישה, לסכם, ולכתוב מייל לכל משימה.", "Multi-step jobs that run in the background: models, knowledge, images and transcription — with conditions and loops. For example: transcribe a meeting, summarize it, and write an email for each action item.")}</p>
      </div>
      <div className="row"><button type="button" className="primary" onClick={() => setEdit({ name: "", inputs: [], steps: [] })}>{L("+ צינור חדש", "+ New pipeline")}</button></div>
      {runId && <RunView runId={runId} onClose={() => { setRunId(null); load(); }} />}
      <RoutinesSection pipelines={list} />
      {list.map((p) => (
        <section key={p.id} className="card persona-card">
          <div className="row">
            <strong>{p.name}</strong>
            <span className="muted small">{L(`${p.steps.length} צעדים`, `${p.steps.length} steps`)}</span>
            <span className="grow" />
            <button type="button" className="primary" onClick={() => { setRunFor(p); setInputs({}); }}>▶ {L("הרצה", "Run")}</button>
            <button type="button" onClick={() => setEdit(p)}>{L("עריכה", "Edit")}</button>
            <button type="button" onClick={() => confirm(L(`למחוק את "${p.name}"?`, `Delete "${p.name}"?`)) && void api(`/api/pipelines/${p.id}`, { method: "DELETE" }).then(load)}>{L("מחיקה", "Delete")}</button>
          </div>
          {p.description && <p className="muted small">{p.description}</p>}
          {runFor?.id === p.id && (
            <form className="stack pl-inputs" onSubmit={(e) => { e.preventDefault(); void start(p); }}>
              {p.inputs.map((inp) => (
                <label key={inp.name} className="pl-field">{inp.label || inp.name}
                  {inp.long ? <textarea rows={4} dir="auto" value={inputs[inp.name] ?? ""} onChange={(e) => setInputs({ ...inputs, [inp.name]: e.target.value })} /> : <input dir="auto" value={inputs[inp.name] ?? ""} onChange={(e) => setInputs({ ...inputs, [inp.name]: e.target.value })} />}
                </label>
              ))}
              <div className="row"><button type="submit" className="primary">▶ {L("התחלה", "Start")}</button><button type="button" onClick={() => setRunFor(null)}>{L("ביטול", "Cancel")}</button></div>
            </form>
          )}
        </section>
      ))}
      {runs.length > 0 && (
        <section className="card stack">
          <strong>{L("הרצות אחרונות", "Recent runs")}</strong>
          <ul className="key-list">
            {runs.map((r) => (
              <li key={r.id} className="row">
                <button type="button" className="as-link" onClick={() => setRunId(r.id)}>{r.name}</button>
                <span className={`pill ${r.status === "done" ? "good" : r.status === "error" ? "bad" : ""}`}>{r.status}</span>
                <span className="muted small grow" dir="auto">{r.error ?? r.last}</span>
                <span className="muted small">{new Date(r.startedAt).toLocaleTimeString(getLocale() === "he" ? "he-IL" : undefined, { hour: "2-digit", minute: "2-digit" })}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card">
        <h3>{L("להתחיל מתבנית", "Start from a template")}</h3>
        <div className="persona-templates">
          {templates.map(localTemplate).map((tp) => <button key={tp.name} type="button" title={tp.description} onClick={() => setEdit({ ...tp })}>{tp.name}</button>)}
        </div>
      </section>
    </div>
  );
}
