import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { autocompletion, snippet, startCompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { indentWithTab, redo, undo } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { csharp } from "@codemirror/legacy-modes/mode/clike";
import { cpp } from "@codemirror/lang-cpp";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { languageOf } from "./languages";
import { setProjectTypes, suggestAt, bracketProblems, missingUsings } from "./csharp-suggest";
import type { EditorHandle, EditorProps } from "./editor-types";
import { LspLite, type LspDiag } from "./lsp-lite";
import { fileUri } from "./lsp-uri";

/** CodeMirror's language for Monaco's language id. */
function langExt(id: string): Extension {
  switch (id) {
    case "csharp":
      return StreamLanguage.define(csharp);
    case "cpp":
    case "c":
    case "hlsl":
      return cpp();
    case "javascript":
      return javascript({ jsx: true });
    case "typescript":
      return javascript({ jsx: true, typescript: true });
    case "python":
      return python();
    case "json":
      return json();
    case "css":
    case "scss":
    case "less":
      return css();
    case "html":
      return html();
    case "markdown":
      return markdown();
    default:
      return [];
  }
}

/** A snippet with $1-style places as CodeMirror's ${} ones. */
const applyOf = (insert: string): Completion["apply"] => (/\$\{?\d/.test(insert) ? snippet(insert.replace(/\$\{(\d+)(?::([^}]*))?\}/g, (_m, _n, d: string | undefined) => `\${${d ?? ""}}`).replace(/\$(\d+)/g, "${}")) : insert);

/** The language server's suggestions (Rider mode), when this editor has one. */
let lspFor: LspLite | undefined;
async function lspCompletions(ctx: CompletionContext) {
  const l = lspFor;
  if (!l) return null;
  const word = ctx.matchBefore(/\w*/);
  const dot = ctx.matchBefore(/[.[<]\w*$/);
  if (!ctx.explicit && !dot && (!word || word.from === word.to)) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const items = await l.complete(line.number - 1, ctx.pos - line.from);
  if (!items.length) return csharpCompletions(ctx);
  return { from: word ? word.from : ctx.pos, options: items.map((i): Completion => ({ label: i.label, apply: i.snippet ? applyOf(i.insert) : i.insert, ...(i.detail ? { detail: i.detail } : {}), ...(i.doc ? { info: i.doc } : {}) })) };
}

/** Unity C# suggestions for CodeMirror (the same knowledge as the desktop editor's). */
function csharpCompletions(ctx: CompletionContext) {
  const word = ctx.matchBefore(/\w*/);
  const dot = ctx.matchBefore(/[.[]\w*$/);
  if (!ctx.explicit && !dot && (!word || word.from === word.to)) return null;
  const items = suggestAt(ctx.state.doc.toString(), ctx.pos);
  const typeOf: Record<string, Completion["type"]> = { method: "method", prop: "property", const: "enum", class: "class", field: "variable", keyword: "keyword", snippet: "text" };
  return {
    from: word ? word.from : ctx.pos,
    options: items.slice(0, 300).map((i): Completion => ({ label: i.label, apply: applyOf(i.insert), type: typeOf[i.kind] ?? "text", ...(i.detail ? { detail: i.detail } : {}), ...(i.doc ? { info: i.doc } : {}) })),
  };
}

/**
 * The touch engine of KesherAI's code editor (phones and tablets): CodeMirror,
 * which works with on-screen keyboards (VS Code's editor does not), with the
 * same colours, suggestions for Unity C#, the live bracket and `using` check
 * and the compiler's errors.
 */
const TouchEditor = forwardRef<EditorHandle, EditorProps>(function TouchEditor(p, ref) {
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(p.onChange);
  change.current = p.onChange;
  const save = useRef(p.onSave);
  save.current = p.onSave;
  const language = p.language ?? languageOf(p.path);
  // Rider mode on a phone: the same language server as the desktop editor (every class of the project and Unity).
  const lsp = useRef<LspLite | undefined>(undefined);
  const lspDiags = useRef<LspDiag[]>([]);
  const [, redraw] = useState(0);

  useEffect(() => {
    if (!box.current) return;
    const v = new EditorView({
      parent: box.current,
      state: EditorState.create({
        doc: p.value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab, { key: "Mod-s", preventDefault: true, run: () => (save.current?.(), true) }]),
          ...(document.documentElement.dataset.light === "1" ? [] : [oneDark]),
          langExt(language),
          ...(language === "csharp" ? [autocompletion({ override: [p.lsp ? lspCompletions : csharpCompletions], activateOnTyping: true })] : []),
          EditorState.readOnly.of(!!p.readOnly),
          EditorView.contentAttributes.of({ autocapitalize: "off", autocorrect: "off", spellcheck: "false" }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const t = u.state.doc.toString();
            change.current(t);
            lsp.current?.change(t);
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, [p.path, language, p.readOnly]);

  useEffect(() => {
    if (!p.lsp || language !== "csharp") return;
    const l = new LspLite(p.lsp.url, fileUri(p.lsp.root), fileUri(p.lsp.file), p.value);
    const status = p.lsp.onStatus ?? (() => undefined);
    status("starting");
    void l.ready.then(() => status("ready"), (e: Error) => status(`error: ${e.message}`));
    l.onDiagnostics = (d) => {
      lspDiags.current = d;
      redraw((n) => n + 1);
    };
    lsp.current = l;
    lspFor = l;
    return () => {
      l.close();
      if (lspFor === l) lspFor = undefined;
      lsp.current = undefined;
    };
  }, [p.lsp?.url, p.lsp?.root, p.lsp?.file, language]);

  // The page's text wins when it is not what the editor already has.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const now = v.state.doc.toString();
    if (now !== p.value) v.dispatch({ changes: { from: 0, to: now.length, insert: p.value } });
  }, [p.value]);

  useEffect(() => {
    if (p.projectTypes) setProjectTypes(p.projectTypes);
  }, [p.projectTypes]);

  // Brackets and `using` (C#) and the compiler's errors as marks in the text.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const text = doc.toString();
    const at = (line: number, col: number) => {
      const l = doc.line(Math.min(Math.max(1, line), doc.lines));
      return Math.min(l.to, l.from + Math.max(0, col - 1));
    };
    const fromLsp = lspDiags.current.map((d) => ({ from: at(d.line + 1, d.character + 1), to: Math.max(at(d.line + 1, d.character + 1) + 1, at(d.endLine + 1, d.endCharacter + 1)), severity: d.severity === 1 ? ("error" as const) : ("warning" as const), message: `${d.code ? `${d.code}: ` : ""}${d.message}` }));
    const live = lsp.current ? fromLsp : language === "csharp" ? [
      ...bracketProblems(text).map((b) => ({ from: b.index, to: Math.min(text.length, b.index + 1), severity: "error" as const, message: b.message })),
      ...missingUsings(text).map((m) => ({ from: m.index, to: m.index + m.type.length, severity: "warning" as const, message: `${m.type} needs "using ${m.ns};" at the top` })),
    ] : [];
    const compiler = (p.problems ?? []).map((x) => {
      const from = at(x.line, x.column);
      return { from, to: Math.max(from + 1, doc.line(Math.min(Math.max(1, x.line), doc.lines)).to), severity: x.severity, message: `${x.code}: ${x.message}` };
    });
    v.dispatch(setDiagnostics(v.state, [...live, ...compiler].filter((d) => d.to <= text.length)));
  });

  useImperativeHandle(ref, () => ({
    suggest: () => {
      const v = view.current;
      if (!v) return;
      v.focus();
      startCompletion(v);
    },
    insert: (text: string) => {
      const v = view.current;
      if (!v) return;
      v.dispatch(v.state.replaceSelection(text));
      v.focus();
    },
    undo: () => view.current && undo(view.current),
    redo: () => view.current && redo(view.current),
    around: () => {
      const v = view.current;
      if (!v) return { prefix: "", suffix: "" };
      const pos = v.state.selection.main.head;
      const t = v.state.doc.toString();
      return { prefix: t.slice(0, pos), suffix: t.slice(pos) };
    },
    focus: () => view.current?.focus(),
  }));

  return <div className={`code-editor touch-editor ${p.className ?? ""}`} ref={box} dir="ltr" />;
});

export default TouchEditor;
