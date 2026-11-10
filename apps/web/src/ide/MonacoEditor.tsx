import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as monaco from "monaco-editor";
import "./monaco-setup";
import { liveMarkers, registerCSharpAssist, setProjectTypes } from "./csharp-assist";
import { languageOf } from "./languages";
import { fileUri, lspLink, registerLspProviders } from "./lsp-client";
import { registerInlineSuggestions } from "./inline-suggest";

import type { EditorHandle, EditorProps } from "./editor-types";

/** Monaco's floating parts (suggestions, hovers) go here: outside the editor's clipping, and left to right even in a Hebrew page (else their text is pushed out of view). */
let overflowHost: HTMLElement | undefined;
function overflowNode(): HTMLElement {
  if (!overflowHost) {
    overflowHost = document.createElement("div");
    overflowHost.className = "monaco-editor kesher-monaco-overflow";
    overflowHost.dir = "ltr";
    document.body.append(overflowHost);
  }
  return overflowHost;
}

/**
 * The desktop engine of KesherAI's code editor (see CodeEditor): VS Code's
 * editor for one file, with Unity-aware help for C#: suggestions
 * (Ctrl+Space, and after a dot), signatures, hovers, a live bracket and
 * `using` check, quick fixes (Ctrl+.), and the compiler's own errors marked on
 * their lines. Ctrl+S saves.
 */
const MonacoEditor = forwardRef<EditorHandle, EditorProps>(function MonacoEditor(p, ref) {
  const language = p.language ?? languageOf(p.path);
  const box = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const change = useRef(p.onChange);
  change.current = p.onChange;
  const save = useRef(p.onSave);
  save.current = p.onSave;
  const own = useRef(false);

  useEffect(() => {
    if (!box.current) return;
    if (language === "csharp") registerCSharpAssist();
    if (!p.readOnly) registerInlineSuggestions();
    const light = document.documentElement.dataset.light === "1";
    const e = monaco.editor.create(box.current, {
      theme: light ? "vs" : "vs-dark",
      automaticLayout: true,
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 13,
      minimap: { enabled: !!p.minimap },
      scrollBeyondLastLine: false,
      tabSize: 4,
      bracketPairColorization: { enabled: true },
      stickyScroll: { enabled: true },
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      wordBasedSuggestions: "currentDocument",
      fixedOverflowWidgets: true,
      overflowWidgetsDomNode: overflowNode(),
      inlineSuggest: { enabled: true, mode: "subword" },
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
    if (!model) model = monaco.editor.createModel(p.value, language, uri);
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
      if (language === "csharp") monaco.editor.setModelMarkers(model!, "live", liveMarkers(model!));
    });
    if (language === "csharp") monaco.editor.setModelMarkers(model, "live", liveMarkers(model));
    return () => sub.dispose();
  }, [p.path, p.value, language]);

  // The language server gets this file (and every change) once it is ready.
  useEffect(() => {
    const model = ed.current?.getModel();
    if (!p.lsp || !model) return;
    registerLspProviders();
    const status = p.lsp.onStatus ?? (() => undefined);
    const link = lspLink(p.lsp.url, p.lsp.root, status);
    const uri = fileUri(p.lsp.file);
    let live = true;
    void link.ready.then(() => {
      if (live) {
        link.open(model, uri);
        status("ready");
      }
    }, (e: Error) => status(`error: ${e.message}`));
    return () => {
      live = false;
      link.close(uri);
    };
  }, [p.lsp?.url, p.lsp?.root, p.lsp?.file]);

  useEffect(() => {
    if (p.projectTypes) setProjectTypes(p.projectTypes);
  }, [p.projectTypes]);

  useEffect(() => {
    const model = ed.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(model, "compiler", (p.problems ?? []).map((x) => ({ severity: x.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning, message: `${x.code}: ${x.message}`, code: x.code, source: "compiler", startLineNumber: x.line, startColumn: x.column, endLineNumber: x.line, endColumn: model.getLineMaxColumn(Math.min(Math.max(1, x.line), model.getLineCount())) })));
  }, [p.problems, p.path]);

  useEffect(() => {
    ed.current?.updateOptions({ readOnly: !!p.readOnly });
  }, [p.readOnly]);

  useImperativeHandle(ref, () => ({
    suggest: () => {
      ed.current?.focus();
      ed.current?.trigger("toolbar", "editor.action.triggerSuggest", {});
    },
    insert: (text: string) => {
      const e = ed.current;
      const sel = e?.getSelection();
      if (!e || !sel) return;
      e.executeEdits("toolbar", [{ range: sel, text, forceMoveMarkers: true }]);
      e.focus();
    },
    undo: () => ed.current?.trigger("toolbar", "undo", null),
    redo: () => ed.current?.trigger("toolbar", "redo", null),
    around: () => {
      const e = ed.current;
      const m = e?.getModel();
      const pos = e?.getPosition();
      if (!m || !pos) return { prefix: "", suffix: "" };
      const full = m.getFullModelRange();
      return { prefix: m.getValueInRange(new monaco.Range(1, 1, pos.lineNumber, pos.column)), suffix: m.getValueInRange(new monaco.Range(pos.lineNumber, pos.column, full.endLineNumber, full.endColumn)) };
    },
    focus: () => ed.current?.focus(),
  }));

  return <div className={`code-editor ${p.className ?? ""}`} ref={box} dir="ltr" />;
});

export default MonacoEditor;
