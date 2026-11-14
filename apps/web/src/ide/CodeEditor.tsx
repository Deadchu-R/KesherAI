import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";
import type { EditorHandle, EditorProps } from "./editor-types";
import { chooseIde, chosenIde, ides, openInChosenIde, type IdeInfo } from "./ide-look";

export type { CodeProblem } from "./editor-types";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
// The engines: VS Code's (Monaco) with a mouse and keyboard, CodeMirror on touch screens (Monaco does not work with on-screen keyboards).
const MonacoEditor = lazy(() => import("./MonacoEditor"));
const TouchEditor = lazy(() => import("./TouchEditor"));
const touch = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches;

/**
 * THE code editor of KesherAI: every place that edits code uses it (the IDE
 * panel, Unity scripts, Unreal C++, Blueprint code), so an improvement here
 * reaches all of them. A toolbar that always shows (also on a phone):
 * suggestions, ✨ complete the line with the model chosen for code
 * suggestions, Tab, undo and redo.
 */
export default function CodeEditor(p: EditorProps) {
  const ref = useRef<EditorHandle>(null);
  const [onTouch] = useState(touch);
  const [completing, setCompleting] = useState(false);
  const Engine = onTouch ? TouchEditor : MonacoEditor;
  // The person's own code editors (VS Code, Cursor, Rider…): their look here, and opening this file in one.
  const [editors, setEditors] = useState<IdeInfo[]>([]);
  const [lookOf, setLookOf] = useState(chosenIde);
  useEffect(() => {
    let live = true;
    void ides().then((l) => live && setEditors(l));
    return () => {
      live = false;
    };
  }, []);
  const openThere = async () => {
    try {
      await openInChosenIde(p.fullPath!, ref.current?.line() ?? 1);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const target = editors.find((x) => x.id === lookOf) ?? editors[0];
  const complete = async () => {
    const h = ref.current;
    if (!h || completing) return;
    setCompleting(true);
    try {
      const { prefix, suffix } = h.around();
      const r = await api<{ text: string; off?: boolean }>("/api/code/complete", { method: "POST", body: { prefix, suffix, language: p.language ?? "", path: p.path } });
      if (r.off) toast(L("בחרו מודל להצעות קוד בהגדרות ← מודלים פעילים ← \"הצעות קוד תוך כדי כתיבה\".", "Choose a model for code suggestions in Settings → Active models → \"Code suggestions while typing\"."));
      else if (r.text) h.insert(r.text);
      else toast(L("למודל אין המשך להציע כאן.", "The model has nothing to add here."));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setCompleting(false);
    }
  };
  return (
    <div className="code-editor-wrap">
      {!p.readOnly && (
        <div className="row code-toolbar" dir="ltr" role="toolbar" aria-label={L("כלי עריכה", "Editing tools")}>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => ref.current?.suggest()} title={L("השלמה (Ctrl+Space)", "Suggestions (Ctrl+Space)")}>💡 {L("השלמה", "Suggest")}</button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} disabled={completing} onClick={() => void complete()} title={L("המודל ממשיך את הקוד מהסמן", "The model continues the code at the cursor")}>{completing ? "…" : `✨ ${L("השלם", "Complete")}`}</button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => ref.current?.insert("    ")} title="Tab">⇥</button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => ref.current?.undo()} title={L("בטל (Ctrl+Z)", "Undo (Ctrl+Z)")} aria-label={L("בטל", "Undo")}>↶</button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => ref.current?.redo()} title={L("חזור (Ctrl+Y)", "Redo (Ctrl+Y)")} aria-label={L("חזור", "Redo")}>↷</button>
          {editors.length > 0 && !onTouch && (
            <select className="code-look" value={lookOf} onChange={(e) => { setLookOf(e.target.value); void chooseIde(e.target.value); }} title={L("המראה של הקוד: כמו בעורך שלך", "How the code looks: like your editor")} aria-label={L("מראה הקוד", "Code look")}>
              <option value="">{L("מראה KesherAI", "KesherAI look")}</option>
              {editors.map((x) => <option key={x.id} value={x.id}>{L(`מראה ${x.name}`, `${x.name} look`)}</option>)}
            </select>
          )}
          {p.fullPath && target && (
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void openThere()} title={L(`פתח את הקובץ ב-${target.name} בשורה של הסמן`, `Open the file in ${target.name} at the cursor's line`)}>↗ {target.name}</button>
          )}
        </div>
      )}
      <Suspense fallback={<div className={`code-editor ${p.className ?? ""}`} />}>
        <Engine ref={ref} {...p} />
      </Suspense>
    </div>
  );
}
