import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { api } from "../api";
import { t } from "../i18n";

/*
 * The code editor is VS Code's own (Monaco, MIT): the same editing, search
 * and replace, multiple cursors, folding, minimap, command palette (F1) and
 * — for TypeScript, JavaScript, JSON, CSS and HTML — suggestions and errors
 * as you type. Its helpers run in web workers from KesherAI itself.
 */
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

/** The editor's language for a file (Monaco knows most by their extension). */
function language(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const byExt: Record<string, string> = { js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", mts: "typescript", py: "python", md: "markdown", markdown: "markdown", json: "json", html: "html", htm: "html", css: "css", scss: "scss", less: "less", c: "c", h: "cpp", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", java: "java", go: "go", rs: "rust", rb: "ruby", php: "php", sh: "shell", bash: "shell", ps1: "powershell", bat: "bat", yml: "yaml", yaml: "yaml", xml: "xml", sql: "sql", lua: "lua", kt: "kotlin", swift: "swift", gd: "python", shader: "hlsl", hlsl: "hlsl", glsl: "cpp", ini: "ini", toml: "ini", dockerfile: "dockerfile" };
  return byExt[ext] ?? (path.toLowerCase().endsWith("dockerfile") ? "dockerfile" : "plaintext");
}

/**
 * A code editor for one file in the conversation's folder — VS Code's
 * editor — with Ctrl+S to save.
 *
 * @param props.convId - Conversation id.
 * @param props.path - File, relative to the folder.
 * @param props.reloadKey - Changes when the agent may have changed the file.
 */
export function EditorPane({ convId, path, reloadKey }: { convId: string; path: string; reloadKey: number }) {
  const box = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [state, setState] = useState<"loading" | "clean" | "dirty" | "saving" | "error">("loading");
  const [error, setError] = useState("");
  const dirty = useRef(false);
  const saveRef = useRef<() => Promise<void>>(async () => undefined);

  const save = async () => {
    if (!editor.current) return;
    setState("saving");
    try {
      await api(`/api/conversations/${convId}/files/text`, { method: "PUT", body: { path, text: editor.current.getValue() } });
      dirty.current = false;
      setState("clean");
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };
  saveRef.current = save;

  // One editor for the pane; each file is its own model (its undo history stays with it).
  useEffect(() => {
    if (!box.current) return;
    const light = document.documentElement.dataset.light === "1";
    const ed = monaco.editor.create(box.current, {
      theme: light ? "vs" : "vs-dark",
      automaticLayout: true,
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 13,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderWhitespace: "selection",
      bracketPairColorization: { enabled: true },
      stickyScroll: { enabled: true },
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
    ed.onDidChangeModelContent(() => {
      if (!dirty.current) {
        dirty.current = true;
        setState("dirty");
      }
    });
    editor.current = ed;
    return () => {
      ed.getModel()?.dispose();
      ed.dispose();
      editor.current = null;
    };
  }, []);

  useEffect(() => {
    if (dirty.current && editor.current?.getModel()) return; // do not throw away the user's unsaved edits
    let cancelled = false;
    setState("loading");
    void api<{ text: string }>(`/api/conversations/${convId}/files/text?path=${encodeURIComponent(path)}`)
      .then(({ text }) => {
        const ed = editor.current;
        if (cancelled || !ed) return;
        const uri = monaco.Uri.parse(`file:///${convId}/${path.replace(/\\/g, "/")}`);
        const old = ed.getModel();
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, language(path), uri);
        if (model.getValue() !== text) model.setValue(text);
        ed.setModel(model);
        if (old && old !== model) old.dispose();
        dirty.current = false;
        setState("clean");
      })
      .catch((e: Error) => {
        setError(e.message);
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [convId, path, reloadKey]);

  return (
    <div className="editor-pane">
      <div className="editor-bar">
        <span className="mono grow" dir="ltr">{path}</span>
        {state === "dirty" && <span className="muted small">{t("unsaved")}</span>}
        <button type="button" disabled={state !== "dirty"} onClick={() => void save()}>{state === "saving" ? "…" : t("save")}</button>
      </div>
      {state === "error" && <p className="error">{error}</p>}
      <div className="editor-host" ref={box} dir="ltr" />
    </div>
  );
}
