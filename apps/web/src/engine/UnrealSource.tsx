import { Suspense, lazy, useEffect, useState } from "react";
import { api } from "../api";
import { CodeAiBubble } from "../CodeAiBubble";
import { Fullscreen } from "../Fullscreen";
import { getLocale } from "../i18n";
import { toast } from "../library";
import type { CodeProblem } from "../ide/CodeEditor";
import { Select } from "../ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
// KesherAI's code editor (VS Code's), loaded when this view opens.
const CodeEditor = lazy(() => import("../ide/CodeEditor"));

interface Build { state: "running" | "ok" | "failed"; how: "live" | "build"; errors: string[]; problems: Array<CodeProblem & { file: string }>; tail: string }

/**
 * An Unreal project's C++ (and Build.cs, Config .ini) in the page: pick a
 * file, edit it in KesherAI's code editor, save (a copy of the old file is
 * kept), compile (Live Coding when the project is open in Unreal, else
 * Unreal's build), see the errors on their lines, and ask the ✨ AI to change
 * the file or fix the errors.
 */
export function UnrealSource() {
  const [projects, setProjects] = useState<Array<{ name: string; path: string; open: boolean }> | null>(null);
  const [project, setProject] = useState("");
  const [files, setFiles] = useState<Array<{ path: string; size: number }>>([]);
  const [q, setQ] = useState("");
  const [path, setPath] = useState("");
  const [file, setFile] = useState<{ text: string; mtime: number } | null>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [build, setBuild] = useState<Build | null>(null);
  const [beforeAi, setBeforeAi] = useState<string | null>(null);

  useEffect(() => {
    void api<{ projects: Array<{ name: string; path: string; open: boolean }> }>("/api/unreal/source/projects").then((r) => {
      setProjects(r.projects);
      setProject((p) => p || (r.projects.find((x) => x.open) ?? r.projects[0])?.path || "");
    }, (e: Error) => toast(e.message));
  }, []);
  useEffect(() => {
    if (!project) return;
    setPath("");
    setFile(null);
    void api<{ files: Array<{ path: string; size: number }> }>(`/api/unreal/source/files?project=${encodeURIComponent(project)}`).then((r) => setFiles(r.files), (e: Error) => toast(e.message));
    void api<{ build: Build | null }>(`/api/unreal/source/compile?project=${encodeURIComponent(project)}`).then((r) => setBuild(r.build), () => undefined);
  }, [project]);
  // While a compile runs, ask how it goes every few seconds.
  useEffect(() => {
    if (build?.state !== "running") return;
    const t = setInterval(() => void api<{ build: Build | null }>(`/api/unreal/source/compile?project=${encodeURIComponent(project)}`).then((r) => {
      setBuild(r.build);
      if (r.build && r.build.state !== "running") toast(r.build.state === "ok" ? L("✅ קומפל בלי שגיאות.", "✅ Compiled with no errors.") : L("הקומפילציה נכשלה: השגיאות מסומנות בקוד.", "The compile failed: the errors are marked in the code."));
    }, () => undefined), 3000);
    return () => clearInterval(t);
  }, [build?.state, project]);

  const open = (p: string) => {
    setPath(p);
    setBeforeAi(null);
    void api<{ text: string; mtime: number }>(`/api/unreal/source/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(p)}`).then((r) => {
      setFile(r);
      setText(r.text);
    }, (e: Error) => toast(e.message));
  };
  const changed = !!file && text !== file.text;
  const save = async () => {
    if (!file || !changed) return;
    setSaving(true);
    try {
      const r = await api<{ mtime: number; issues: string[] }>("/api/unreal/source/file", { method: "PUT", body: { project, path, text, mtime: file.mtime } });
      setFile({ text, mtime: r.mtime });
      setBeforeAi(null);
      toast(r.issues.length ? L(`נשמר. שימו לב: ${r.issues.join(" · ")}`, `Saved. Note: ${r.issues.join(" · ")}`) : L("נשמר.", "Saved."));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const compile = async () => {
    if (changed) await save();
    try {
      const r = await api<{ build: Build }>("/api/unreal/source/compile", { method: "POST", body: { project } });
      setBuild(r.build);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const mine = (build?.problems ?? []).filter((e) => e.file.toLowerCase() === path.toLowerCase());
  const askAi = async (request: string, fix: boolean, model: string) => {
    const r = await api<{ code: string; note: string }>("/api/unreal/source/ai", { method: "POST", body: { project, path, text, request, ...(model ? { model } : {}), ...(fix || mine.length ? { errors: mine } : {}) } });
    if (r.code.trim() === text.trim()) return L("ה-AI לא שינה כלום.", "The AI changed nothing.");
    setBeforeAi(text);
    setText(r.code);
    return r.note;
  };
  const shown = files.filter((f) => f.path.toLowerCase().includes(q.toLowerCase())).slice(0, 400);
  const current = projects?.find((p) => p.path === project);

  if (projects && !projects.length) return <p className="muted card">{L("לא נמצאו פרויקטים של Unreal במחשב.", "No Unreal projects were found on this computer.")}</p>;
  return (
    <div className="ue-body script-nodes unreal-source">
      <aside className="ue-list card">
        <Select value={project} onChange={(e) => setProject(e.target.value)} aria-label={L("פרויקט", "Project")}>
          {(projects ?? []).map((p) => <option key={p.path} value={p.path}>{p.name}{p.open ? ` · ${L("פתוח ב-Unreal", "open in Unreal")}` : ""}</option>)}
        </Select>
        <input value={q} placeholder={L("חיפוש קובץ…", "Find a file…")} onChange={(e) => setQ(e.target.value)} aria-label={L("חיפוש קובץ", "Find a file")} />
        <Select className="ue-select" value={path} onChange={(e) => e.target.value && open(e.target.value)} aria-label={L("קובץ", "File")}>
          <option value="">{L("בחרו קובץ…", "Choose a file…")}</option>
          {files.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}
        </Select>
        <ul>
          {shown.map((f) => (
            <li key={f.path}><button type="button" className={f.path === path ? "on" : ""} onClick={() => open(f.path)} title={f.path} dir="ltr">{f.path.replace(/^Source\//, "")}</button></li>
          ))}
          {!files.length && <li className="muted small">{L("אין קבצי C++ בפרויקט הזה (פרויקט Blueprint בלבד).", "No C++ files in this project (Blueprint only).")}</li>}
        </ul>
      </aside>
      <section className="card stack ue-main">
        <div className="row wrap">
          <strong className="grow" dir="ltr">{path || current?.name}</strong>
          <button type="button" disabled={!changed || saving} onClick={() => setText(file?.text ?? "")}>{L("בטל שינויים", "Discard changes")}</button>
          <button type="button" disabled={!changed || saving} onClick={() => void save()}>{saving ? "…" : L("💾 שמור", "💾 Save")}</button>
          <button type="button" className="primary" disabled={build?.state === "running" || !project} onClick={() => void compile()} title={current?.open ? L("Live Coding בעורך הפתוח", "Live Coding in the open editor") : L("הבנייה של Unreal (העורך צריך להיות סגור)", "Unreal's build (the editor must be closed)")}>
            {build?.state === "running" ? L("מקמפל…", "Compiling…") : current?.open ? L("⚡ Live Coding", "⚡ Live Coding") : L("🔨 קמפל", "🔨 Compile")}
          </button>
        </div>
        {build && build.state !== "running" && (
          <div className={`small ${build.state === "ok" ? "" : "error"}`}>
            {build.state === "ok" ? L("✅ הקומפילציה האחרונה עברה.", "✅ The last compile passed.") : <>❌ {L("הקומפילציה האחרונה נכשלה", "The last compile failed")}{build.errors.length ? `: ${build.errors.slice(0, 3).join(" · ")}` : ""}</>}
          </div>
        )}
        {!file ? (
          <p className="muted">{L("בחרו קובץ C++ כדי לערוך אותו: השלמה, חיפוש (Ctrl+F), שמירה (Ctrl+S), קומפילציה ו-✨ AI שמשנה או מתקן.", "Pick a C++ file to edit it: suggestions, search (Ctrl+F), save (Ctrl+S), compile, and ✨ AI that changes or fixes it.")}</p>
        ) : (
          <Fullscreen className="script-fs" label={L("הקוד במסך מלא", "The code, full screen")}>
            <div className="script-code-wrap">
              <Suspense fallback={<p className="muted">…</p>}>
                <CodeEditor path={`${current?.name ?? "project"}/${path}`} fullPath={`${project.replace(/[\\/][^\\/]+\.uproject$/i, "")}/${path}`} value={text} onChange={setText} problems={mine} onSave={() => void save()} />
              </Suspense>
              {mine.length > 0 && (
                <ul className="code-problems">
                  {mine.map((e, i) => <li key={i} className={e.severity} dir="ltr"><span className="mono">{e.line}:{e.column}</span> {e.code} {e.message}</li>)}
                </ul>
              )}
              <CodeAiBubble ask={askAi} errors={mine.filter((e) => e.severity === "error").length} canUndo={beforeAi !== null} onUndo={() => { if (beforeAi !== null) { setText(beforeAi); setBeforeAi(null); } }} placeholder={L("למשל: תוסיף UPROPERTY של מהירות", "e.g. add a Speed UPROPERTY")} />
            </div>
          </Fullscreen>
        )}
      </section>
    </div>
  );
}
