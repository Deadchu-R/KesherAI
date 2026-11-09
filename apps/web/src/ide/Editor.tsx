import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import CodeEditor from "./CodeEditor";

/**
 * The IDE panel's editor for one file of the conversation's folder: KesherAI's
 * code editor (VS Code's, with search and replace, multiple cursors, folding,
 * the command palette F1, and suggestions and errors as you type for
 * TypeScript, JavaScript, JSON, CSS, HTML and Unity C#), with Ctrl+S to save.
 *
 * @param props.convId - Conversation id.
 * @param props.path - File, relative to the folder.
 * @param props.reloadKey - Changes when the agent may have changed the file.
 */
export function EditorPane({ convId, path, reloadKey }: { convId: string; path: string; reloadKey: number }) {
  const [state, setState] = useState<"loading" | "clean" | "dirty" | "saving" | "error">("loading");
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const dirty = useRef(false);
  const current = useRef("");

  const save = async () => {
    setState("saving");
    try {
      await api(`/api/conversations/${convId}/files/text`, { method: "PUT", body: { path, text: current.current } });
      dirty.current = false;
      setState("clean");
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  useEffect(() => {
    if (dirty.current) return; // do not throw away the user's unsaved edits
    let cancelled = false;
    setState("loading");
    void api<{ text: string }>(`/api/conversations/${convId}/files/text?path=${encodeURIComponent(path)}`)
      .then(({ text: loaded }) => {
        if (cancelled) return;
        current.current = loaded;
        setText(loaded);
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
      <CodeEditor
        className="editor-host"
        path={`${convId}/${path.replace(/\\/g, "/")}`}
        value={text}
        minimap
        onChange={(v) => {
          current.current = v;
          setText(v);
          if (!dirty.current) {
            dirty.current = true;
            setState("dirty");
          }
        }}
        onSave={() => dirty.current && void save()}
      />
    </div>
  );
}
