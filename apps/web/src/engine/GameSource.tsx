import { Suspense, lazy, useEffect, useState } from "react";
import { api } from "../api";
import { CodeAiBubble } from "../CodeAiBubble";
import { Fullscreen } from "../Fullscreen";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import type { CodeProblem } from "../ide/CodeEditor";
import { Select } from "../ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
// KesherAI's code editor (VS Code's on a computer, CodeMirror on a phone), loaded when this view opens.
const CodeEditor = lazy(() => import("../ide/CodeEditor"));

/** An engine with a Source view. */
export type SourceEngine = "unity" | "unreal" | "godot";
type Problem = CodeProblem & { file: string };
interface Build { state: "running" | "ok" | "failed"; how: "live" | "build"; errors: string[]; problems: Problem[]; tail: string }
interface SourceFile { path: string; size: number; lang: string }
interface Opened { text: string; mtime: number; lang: string; outline: Array<{ symbol: string; line: number }> }

const LANG_LABEL: Record<string, string> = { csharp: "C#", cpp: "C++", gdscript: "GDScript", verse: "Verse", ini: "INI", shader: "Shader" };
const ENGINE_LABEL: Record<SourceEngine, string> = { unity: "Unity", unreal: "Unreal", godot: "Godot" };
/** The editor's language for a file (GDScript and Verse are coloured as Python, the closest one it has). */
const editorLang = (lang: string) => (lang === "csharp" ? "csharp" : lang === "cpp" ? "cpp" : lang === "ini" ? "ini" : lang === "shader" ? "hlsl" : "python");
const sameFile = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase().endsWith(b.replace(/\\/g, "/").toLowerCase());

/**
 * The Source view, the same for every engine (step 4 of the engine-closed plan): a project's C#, C++, GDScript and
 * Verse files in one list, the file in KesherAI's code editor with its colours, an outline of its classes and
 * functions, go-to-definition through the project's index, save (the old text is kept), the engine's compile where
 * there is one today (Unreal: Live Coding or its build; Unity: the project on the Unity page) with the errors on their
 * lines, and the ✨ AI for C++ and C#. Works with the engine closed and from the phone.
 *
 * @param p.engine - The engine.
 * @param p.project - The project's folder (else a picker of the engine's projects found on this computer).
 * @param p.open - A file to open first, at a line (from a search result).
 */
export function GameSource({ engine, project: fixed, open: first }: { engine: SourceEngine; project?: string; open?: { path: string; line?: number } }) {
  const [projects, setProjects] = useState<Array<{ name: string; path: string; open: boolean }> | null>(null);
  const [project, setProject] = useState(fixed ?? "");
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [compile, setCompile] = useState<"unreal" | "unity" | null>(null);
  const [q, setQ] = useState("");
  const [path, setPath] = useState("");
  const [file, setFile] = useState<Opened | null>(null);
  const [text, setText] = useState("");
  const [jump, setJump] = useState<{ line: number; n: number } | undefined>();
  const [saving, setSaving] = useState(false);
  const [build, setBuild] = useState<Build | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [beforeAi, setBeforeAi] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const qs = (extra: Record<string, string> = {}) => new URLSearchParams({ engine, project, ...extra }).toString();

  useEffect(() => {
    if (fixed) setProject(fixed);
    void api<{ projects: Array<{ engine: string; name: string; path: string; open: boolean }> }>("/api/games").then((r) => {
      const mine = r.projects.filter((p) => p.engine === engine);
      setProjects(mine);
      setProject((p) => p || (mine.find((x) => x.open) ?? mine[0])?.path || "");
    }, (e: Error) => toast(e.message));
  }, [engine, fixed]);
  useEffect(() => {
    if (!project) return;
    setPath("");
    setFile(null);
    setProblems([]);
    void api<{ files: SourceFile[]; compile: "unreal" | "unity" | null }>(`/api/games/source/files?${qs()}`).then((r) => {
      setFiles(r.files);
      setCompile(r.compile);
      if (first && r.files.some((f) => f.path === first.path)) openFile(first.path, first.line);
    }, (e: Error) => toast(e.message));
    if (engine === "unreal") void api<{ build: Build | null }>(`/api/unreal/source/compile?project=${encodeURIComponent(project)}`).then((r) => setBuild(r.build), () => undefined);
  }, [project]);
  // While an Unreal compile runs, ask how it goes every few seconds.
  useEffect(() => {
    if (build?.state !== "running") return;
    const t = setInterval(() => void api<{ build: Build | null }>(`/api/unreal/source/compile?project=${encodeURIComponent(project)}`).then((r) => {
      setBuild(r.build);
      if (r.build && r.build.state !== "running") {
        setProblems(r.build.problems);
        toast(r.build.state === "ok" ? L("✅ קומפל בלי שגיאות.", "✅ Compiled with no errors.") : L("הקומפילציה נכשלה: השגיאות מסומנות בקוד.", "The compile failed: the errors are marked in the code."));
      }
    }, () => undefined), 3000);
    return () => clearInterval(t);
  }, [build?.state, project]);

  function openFile(p: string, line?: number) {
    setPath(p);
    setBeforeAi(null);
    setOutlineOpen(false);
    void api<Opened>(`/api/games/source/file?${qs({ path: p })}`).then((r) => {
      setFile(r);
      setText(r.text);
      if (line) setJump({ line, n: Date.now() });
    }, (e: Error) => toast(e.message));
  }
  const changed = !!file && text !== file.text;
  const save = async () => {
    if (!file || !changed) return;
    setSaving(true);
    try {
      const r = await api<{ mtime: number; issues: string[] }>("/api/games/source/file", { method: "PUT", body: { engine, project, path, text, mtime: file.mtime } });
      setFile({ ...file, text, mtime: r.mtime });
      setBeforeAi(null);
      toast(r.issues.length ? L(`נשמר. שימו לב: ${r.issues.join(" · ")}`, `Saved. Note: ${r.issues.join(" · ")}`) : L("נשמר.", "Saved."));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const runCompile = async () => {
    if (changed) await save();
    try {
      if (compile === "unreal") {
        const r = await api<{ build: Build }>("/api/unreal/source/compile", { method: "POST", body: { project } });
        setBuild(r.build);
        return;
      }
      const r = await api<{ ok: boolean; offline?: boolean; note?: string; errors: Problem[] }>("/api/unity/scripts/compile", { method: "POST" });
      setProblems(r.errors);
      const mineErrors = r.errors.filter((e) => e.severity === "error" && sameFile(e.file, path)).length;
      toast(r.offline ? (r.note ?? L("Unity סגור, אז הקוד לא קומפל.", "Unity is closed, so nothing was compiled.")) : r.ok ? L("✅ מתקמפל בלי שגיאות.", "✅ Compiles with no errors.") : L(`${mineErrors} שגיאות בקובץ הזה.`, `${mineErrors} error(s) in this file.`));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  /** Go to definition: in this file when it is here, else the file that defines it (one, or the first of several). */
  const goToDefinition = (word: string) => {
    if (!word) return toast(L("שימו את הסמן על שם של מחלקה או פונקציה.", "Put the cursor on a class or function name."));
    const bare = word.split("::").pop()!;
    void api<{ definitions: Array<{ path: string; line: number; symbol: string }> }>(`/api/games/source/definition?${qs({ name: word })}`).then((r) => {
      const d = r.definitions.find((x) => x.path === path) ?? r.definitions[0];
      if (!d) return toast(L(`"${bare}" לא מוגדר בקוד של הפרויקט (אולי של המנוע).`, `"${bare}" is not defined in the project's code (the engine's, maybe).`));
      if (r.definitions.length > 1) toast(L(`${r.definitions.length} הגדרות; נפתחה ${d.path}`, `${r.definitions.length} definitions; opened ${d.path}`));
      if (d.path === path) setJump({ line: d.line, n: Date.now() });
      else if (changed) toast(L("שמרו קודם את הקובץ הזה.", "Save this file first."));
      else openFile(d.path, d.line);
    }, (e: Error) => toast(e.message));
  };
  const mine = problems.filter((e) => sameFile(e.file, path) || sameFile(path, e.file));
  const lang = file?.lang ?? "";
  // The ✨ AI: Unreal C++ and Unity C# (the routes those views had); not for GDScript, Verse or settings yet.
  const aiRoute = engine === "unreal" && /^(Source|Config)\//.test(path) && lang !== "verse" ? "/api/unreal/source/ai" : engine === "unity" && compile === "unity" ? "/api/unity/script/ai" : "";
  const askAi = async (request: string, fix: boolean, model: string) => {
    const r = await api<{ code: string; note: string }>(aiRoute, { method: "POST", body: { project, path, text, request, ...(model ? { model } : {}), ...(fix || mine.length ? { errors: mine } : {}) } });
    if (r.code.trim() === text.trim()) return L("ה-AI לא שינה כלום.", "The AI changed nothing.");
    setBeforeAi(text);
    setText(r.code);
    return r.note;
  };
  const shown = files.filter((f) => f.path.toLowerCase().includes(q.toLowerCase())).slice(0, 400);
  const norm = (x: string) => x.replace(/[\\/]+$/, "").toLowerCase();
  const current = projects?.find((p) => norm(p.path) === norm(project));
  const compileTitle = compile === "unreal" ? (current?.open ? L("Live Coding בעורך הפתוח", "Live Coding in the open editor") : L("הבנייה של Unreal (העורך צריך להיות סגור)", "Unreal's build (the editor must be closed)")) : L("Unity מקמפל את הסקריפטים", "Unity compiles the scripts");
  const shortPath = (p: string) => p.replace(/^(Source|Assets)\//, "");

  if (projects && !projects.length && !fixed) return <p className="muted card">{L(`לא נמצאו פרויקטים של ${ENGINE_LABEL[engine]} במחשב.`, `No ${ENGINE_LABEL[engine]} projects were found on this computer.`)}</p>;
  return (
    <div className="ue-body script-nodes game-source">
      <aside className="ue-list card">
        {!fixed && (
          <Select value={project} onChange={(e) => setProject(e.target.value)} aria-label={L("פרויקט", "Project")}>
            {(projects ?? []).map((p) => <option key={p.path} value={p.path}>{p.name}{p.open ? ` · ${L(`פתוח ב-${ENGINE_LABEL[engine]}`, `open in ${ENGINE_LABEL[engine]}`)}` : ""}</option>)}
          </Select>
        )}
        <input value={q} placeholder={L("חיפוש קובץ…", "Find a file…")} onChange={(e) => setQ(e.target.value)} aria-label={L("חיפוש קובץ", "Find a file")} />
        <Select className="ue-select" value={path} onChange={(e) => e.target.value && openFile(e.target.value)} aria-label={L("קובץ", "File")}>
          <option value="">{L("בחרו קובץ…", "Choose a file…")}</option>
          {files.map((f) => <option key={f.path} value={f.path}>{shortPath(f.path)} · {LANG_LABEL[f.lang] ?? f.lang}</option>)}
        </Select>
        <ul>
          {shown.map((f) => (
            <li key={f.path}>
              <button type="button" className={f.path === path ? "on" : ""} onClick={() => openFile(f.path)} title={f.path} dir="ltr">
                <span className="game-source-lang">{LANG_LABEL[f.lang] ?? f.lang}</span> {shortPath(f.path)}
              </button>
            </li>
          ))}
          {!files.length && <li className="muted small">{L("אין קבצי קוד בפרויקט הזה.", "No code files in this project.")}</li>}
        </ul>
      </aside>
      <section className="card stack ue-main">
        <div className="row wrap">
          <strong className="grow game-source-path" dir="ltr">{path || current?.name}</strong>
          {file && <span className="games-chip">{LANG_LABEL[lang] ?? lang}</span>}
          <button type="button" disabled={!changed || saving} onClick={() => setText(file?.text ?? "")}>{L("בטל שינויים", "Discard changes")}</button>
          <button type="button" disabled={!changed || saving} onClick={() => void save()}>{saving ? "…" : L("💾 שמור", "💾 Save")}</button>
          {compile && (
            <button type="button" className="primary" disabled={build?.state === "running" || !project} onClick={() => void runCompile()} title={compileTitle}>
              {build?.state === "running" ? L("מקמפל…", "Compiling…") : compile === "unreal" && current?.open ? "⚡ Live Coding" : L("🔨 קמפל", "🔨 Compile")}
            </button>
          )}
        </div>
        {build && build.state !== "running" && compile === "unreal" && (
          <div className={`small ${build.state === "ok" ? "" : "error"}`}>
            {build.state === "ok" ? L("✅ הקומפילציה האחרונה עברה.", "✅ The last compile passed.") : <>❌ {L("הקומפילציה האחרונה נכשלה", "The last compile failed")}{build.errors.length ? `: ${build.errors.slice(0, 3).join(" · ")}` : ""}</>}
          </div>
        )}
        {file && file.outline.length > 0 && (
          <details className="game-source-outline" open={outlineOpen} onToggle={(e) => setOutlineOpen((e.target as HTMLDetailsElement).open)}>
            <summary className="small">{L(`מבנה הקובץ (${file.outline.length})`, `Outline (${file.outline.length})`)}</summary>
            <ul dir="ltr">
              {file.outline.map((o) => (
                <li key={`${o.line}:${o.symbol}`}><button type="button" className="link" onClick={() => setJump({ line: o.line, n: Date.now() })}><span className="muted mono">{o.line}</span> {o.symbol}</button></li>
              ))}
            </ul>
          </details>
        )}
        {!file ? (
          <p className="muted">{L("בחרו קובץ כדי לערוך אותו: צבעים לפי שפה, מבנה הקובץ, מעבר להגדרה, שמירה (Ctrl+S) וקומפילציה במנוע שיש לו. עובד גם כשהמנוע סגור.", "Pick a file to edit it: colours by language, the file's outline, go to definition, save (Ctrl+S), and the engine's compile where it has one. Works with the engine closed too.")}</p>
        ) : (
          <Fullscreen className="script-fs" label={L("הקוד במסך מלא", "The code, full screen")}>
            <div className="script-code-wrap">
              <Suspense fallback={<p className="muted">…</p>}>
                <CodeEditor path={`${current?.name ?? "project"}/${path}`} fullPath={`${project}/${path}`} language={editorLang(lang)} value={text} onChange={setText} problems={mine} onSave={() => void save()} {...(jump ? { jump } : {})} onDefinition={goToDefinition} />
              </Suspense>
              {mine.length > 0 && (
                <ul className="code-problems">
                  {mine.map((e, i) => <li key={i} className={e.severity} dir="ltr"><button type="button" className="link" onClick={() => setJump({ line: e.line, n: Date.now() })}><span className="mono">{e.line}:{e.column}</span></button> {e.code} {e.message}</li>)}
                </ul>
              )}
              {aiRoute && <CodeAiBubble ask={askAi} errors={mine.filter((e) => e.severity === "error").length} canUndo={beforeAi !== null} onUndo={() => { if (beforeAi !== null) { setText(beforeAi); setBeforeAi(null); } }} placeholder={engine === "unreal" ? L("למשל: תוסיף UPROPERTY של מהירות", "e.g. add a Speed UPROPERTY") : L("למשל: תוסיף קפיצה כפולה", "e.g. add a double jump")} />}
            </div>
          </Fullscreen>
        )}
      </section>
    </div>
  );
}
