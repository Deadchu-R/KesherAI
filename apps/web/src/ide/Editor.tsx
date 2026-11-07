import { useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { cpp } from "@codemirror/lang-cpp";
import { api } from "../api";
import { t } from "../i18n";

function language(path: string): Extension[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return [javascript({ jsx: true })];
  if (["ts", "tsx", "mts"].includes(ext)) return [javascript({ jsx: ext === "tsx", typescript: true })];
  if (ext === "py") return [python()];
  if (["md", "markdown"].includes(ext)) return [markdown()];
  if (ext === "json") return [json()];
  if (["html", "htm"].includes(ext)) return [html()];
  if (["css", "scss"].includes(ext)) return [css()];
  if (["c", "cc", "cpp", "h", "hpp", "cs"].includes(ext)) return [cpp()];
  return [];
}

/**
 * A code editor for one file in the conversation's folder, with syntax
 * colours and Ctrl+S to save.
 *
 * @param props.convId - Conversation id.
 * @param props.path - File, relative to the folder.
 * @param props.reloadKey - Changes when the agent may have changed the file.
 */
export function EditorPane({ convId, path, reloadKey }: { convId: string; path: string; reloadKey: number }) {
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [state, setState] = useState<"loading" | "clean" | "dirty" | "saving" | "error">("loading");
  const [error, setError] = useState("");
  const dirty = useRef(false);

  const save = async () => {
    if (!view.current) return;
    setState("saving");
    try {
      await api(`/api/conversations/${convId}/files/text`, { method: "PUT", body: { path, text: view.current.state.doc.toString() } });
      dirty.current = false;
      setState("clean");
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  useEffect(() => {
    if (dirty.current && view.current) return; // do not throw away the user's unsaved edits
    let cancelled = false;
    setState("loading");
    void api<{ text: string }>(`/api/conversations/${convId}/files/text?path=${encodeURIComponent(path)}`)
      .then(({ text }) => {
        if (cancelled || !box.current) return;
        view.current?.destroy();
        view.current = new EditorView({
          parent: box.current,
          state: EditorState.create({
            doc: text,
            extensions: [
              basicSetup,
              oneDark,
              ...language(path),
              keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (void save(), true) }]),
              EditorView.updateListener.of((u) => {
                if (u.docChanged) {
                  dirty.current = true;
                  setState("dirty");
                }
              }),
              EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: '"IBM Plex Mono", monospace', fontSize: "13px" } }),
            ],
          }),
        });
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

  useEffect(() => () => view.current?.destroy(), []);

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
