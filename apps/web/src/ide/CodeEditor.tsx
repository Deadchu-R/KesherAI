import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import "./monaco-setup";
import { liveMarkers, registerCSharpAssist, setProjectTypes } from "./csharp-assist";

/** A compiler problem to mark in the code (from Unity or Unreal). */
export interface CodeProblem { line: number; column: number; code: string; message: string; severity: "error" | "warning" }

/**
 * VS Code's editor for one script, with Unity-aware help for C#: suggestions
 * (Ctrl+Space, and after a dot), signatures, hovers, a live bracket and
 * `using` check, quick fixes (Ctrl+.), and the compiler's own errors marked on
 * their lines. Ctrl+S saves.
 */
export default function CodeEditor(p: { path: string; value: string; onChange: (v: string) => void; language: "csharp" | "cpp"; problems?: CodeProblem[]; projectTypes?: string[]; onSave?: () => void; readOnly?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const change = useRef(p.onChange);
  change.current = p.onChange;
  const save = useRef(p.onSave);
  save.current = p.onSave;
  const own = useRef(false);

  useEffect(() => {
    if (!box.current) return;
    if (p.language === "csharp") registerCSharpAssist();
    const light = document.documentElement.dataset.light === "1";
    const e = monaco.editor.create(box.current, {
      theme: light ? "vs" : "vs-dark",
      automaticLayout: true,
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 4,
      bracketPairColorization: { enabled: true },
      stickyScroll: { enabled: true },
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      wordBasedSuggestions: "currentDocument",
      fixedOverflowWidgets: true,
      readOnly: !!p.readOnly,
    });
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save.current?.());
    ed.current = e;
    return () => {
      e.getModel()?.dispose();
      e.dispose();
      ed.current = null;
    };
  }, []);

  // One model per file; the page's text wins unless it is what the editor just sent.
  useEffect(() => {
    const e = ed.current;
    if (!e) return;
    const uri = monaco.Uri.parse(`kesher:///${p.path.replace(/\\/g, "/")}`);
    let model = monaco.editor.getModel(uri);
    if (!model) model = monaco.editor.createModel(p.value, p.language, uri);
    if (e.getModel() !== model) {
      const old = e.getModel();
      e.setModel(model);
      if (old && old !== model) old.dispose();
    }
    if (model.getValue() !== p.value && !own.current) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: p.value }], () => null);
    own.current = false;
    const sub = model.onDidChangeContent(() => {
      own.current = true;
      change.current(model!.getValue());
      if (p.language === "csharp") monaco.editor.setModelMarkers(model!, "live", liveMarkers(model!));
    });
    if (p.language === "csharp") monaco.editor.setModelMarkers(model, "live", liveMarkers(model));
    return () => sub.dispose();
  }, [p.path, p.value, p.language]);

  useEffect(() => {
    if (p.projectTypes) setProjectTypes(p.projectTypes);
  }, [p.projectTypes]);

  useEffect(() => {
    const model = ed.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(model, "compiler", (p.problems ?? []).map((x) => ({ severity: x.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning, message: `${x.code}: ${x.message}`, code: x.code, source: "compiler", startLineNumber: x.line, startColumn: x.column, endLineNumber: x.line, endColumn: model.getLineMaxColumn(Math.min(Math.max(1, x.line), model.getLineCount())) })));
  }, [p.problems, p.path]);

  return <div className="code-editor" ref={box} dir="ltr" />;
}
