import * as monaco from "monaco-editor";
import { lspServes } from "./lsp-client";
import { NAMESPACE_OF, UNITY_API, UNITY_EVENTS_SNIPPETS, type ApiMember } from "./unity-api";
import { KEYWORDS, bracketProblems, chainBefore, close, membersAfter, missingUsings, ownMembers, projectTypes } from "./csharp-suggest";
export { bracketProblems, missingUsings, setProjectTypes } from "./csharp-suggest";

/**
 * Rider-like help for Unity C# in Monaco: suggestions that know the Unity API
 * and the script's own variables (also after a dot: `transform.position.`),
 * the signature of the method being called, a short description on hover, a
 * live check of brackets and missing `using` lines, and quick fixes (add the
 * `using`, add a missing `;`, a close name for an unknown one).
 */

const kindOf = (x: ApiMember) => (x.kind === "method" ? monaco.languages.CompletionItemKind.Method : x.kind === "const" ? monaco.languages.CompletionItemKind.EnumMember : monaco.languages.CompletionItemKind.Property);

let registered = false;
/** Registers the C# helpers once (they read whichever C# file is open). */
export function registerCSharpAssist(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider("csharp", {
    triggerCharacters: ["."],
    provideCompletionItems(model, pos) {
      if (lspServes(model)) return { suggestions: [] };
      const line = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
      const word = model.getWordUntilPosition(pos);
      const range = new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn);
      const text = model.getValue();
      const chain = /\.\w*$/.test(line) ? chainBefore(line) : undefined;
      if (chain) {
        const found = membersAfter(text, chain);
        if (!found) return { suggestions: [] };
        return {
          suggestions: found.members.map((x) => ({
            label: x.name,
            kind: kindOf(x),
            detail: x.sig ? `${x.sig}${x.type && x.type !== "void" ? ` → ${x.type}` : ""}` : x.type,
            documentation: x.doc,
            insertText: x.kind === "method" ? (/<T>/.test(x.sig ?? "") ? `${x.name}<\${1:T}>()` : /\(\)$/.test(x.sig ?? "") ? `${x.name}()` : `${x.name}($0)`) : x.name,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          })),
        };
      }
      const s: monaco.languages.CompletionItem[] = [];
      for (const [name, api] of Object.entries(UNITY_API)) s.push({ label: name, kind: monaco.languages.CompletionItemKind.Class, detail: api.ns ? `${api.ns}.${name}` : `UnityEngine.${name}`, documentation: api.doc, insertText: name, range });
      for (const n of projectTypes) s.push({ label: n, kind: monaco.languages.CompletionItemKind.Class, detail: "Script in this project", insertText: n, range });
      for (const x of ownMembers(text)) s.push({ label: x.name, kind: x.kind === "method" ? monaco.languages.CompletionItemKind.Method : monaco.languages.CompletionItemKind.Field, detail: x.detail, insertText: x.kind === "method" ? `${x.name}($0)` : x.name, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, sortText: "0", range });
      for (const x of UNITY_API.MonoBehaviour!.members) s.push({ label: x.name, kind: kindOf(x), detail: x.sig ?? x.type, documentation: x.doc, insertText: x.kind === "method" ? (/<T>/.test(x.sig ?? "") ? `${x.name}<\${1:T}>()` : `${x.name}($0)`) : x.name, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, sortText: "1", range });
      for (const sn of UNITY_EVENTS_SNIPPETS) s.push({ label: sn.label, kind: monaco.languages.CompletionItemKind.Snippet, detail: "Unity", documentation: sn.doc, insertText: sn.body, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, sortText: "2", range });
      for (const k of KEYWORDS) s.push({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k, sortText: "3", range });
      return { suggestions: s };
    },
  });
  monaco.languages.registerHoverProvider("csharp", {
    provideHover(model, pos) {
      if (lspServes(model)) return null;
      const w = model.getWordAtPosition(pos);
      if (!w) return null;
      const before = model.getLineContent(pos.lineNumber).slice(0, w.startColumn - 1);
      const chain = /\.$/.test(before) ? chainBefore(`${before}${w.word}`) : undefined;
      const mem = chain ? membersAfter(model.getValue(), chain)?.members.find((x) => x.name === w.word) : undefined;
      const api = UNITY_API[w.word];
      const text = mem ? `**${mem.sig ?? mem.name}**${mem.type ? ` → \`${mem.type}\`` : ""}${mem.doc ? `\n\n${mem.doc}` : ""}` : api ? `**${w.word}** (${api.ns ?? "UnityEngine"})\n\n${api.doc}` : undefined;
      return text ? { contents: [{ value: text }], range: new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn) } : null;
    },
  });
  monaco.languages.registerSignatureHelpProvider("csharp", {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp(model, pos) {
      if (lspServes(model)) return null;
      const line = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
      let depth = 0;
      let i = line.length - 1;
      let commas = 0;
      for (; i >= 0; i--) {
        const c = line[i];
        if (c === ")") depth++;
        else if (c === "(") {
          if (!depth) break;
          depth--;
        } else if (c === "," && !depth) commas++;
      }
      if (i < 0) return null;
      const head = line.slice(0, i);
      const name = /(\w+)(?:<\w+>)?$/.exec(head)?.[1];
      if (!name) return null;
      const chain = /\.\w+(?:<\w+>)?$/.test(head) ? chainBefore(head.replace(/(<\w+>)?$/, "")) : undefined;
      const mems = chain ? membersAfter(model.getValue(), chain)?.members ?? [] : UNITY_API.MonoBehaviour!.members;
      const mem = mems.find((x) => x.name === name && x.kind === "method");
      if (!mem?.sig) return null;
      const params = (/\((.*)\)/.exec(mem.sig)?.[1] ?? "").split(/,\s*/).filter(Boolean);
      return { value: { signatures: [{ label: mem.sig, documentation: mem.doc, parameters: params.map((p) => ({ label: p })) }], activeSignature: 0, activeParameter: Math.min(commas, Math.max(0, params.length - 1)) }, dispose: () => undefined };
    },
  });
  monaco.languages.registerCodeActionProvider("csharp", {
    provideCodeActions(model, _range, context) {
      const actions: monaco.languages.CodeAction[] = [];
      if (lspServes(model)) return { actions, dispose: () => undefined };
      const text = model.getValue();
      const usingAt = (() => {
        const lines = text.split("\n");
        let last = 0;
        lines.forEach((l, i) => /^\s*using\s+[\w.]+\s*;/.test(l) && (last = i + 1));
        return last + 1;
      })();
      for (const mk of context.markers) {
        const code = typeof mk.code === "string" ? mk.code : mk.code?.value;
        const word = model.getWordAtPosition({ lineNumber: mk.startLineNumber, column: mk.startColumn })?.word ?? /'(\w+)'/.exec(mk.message)?.[1] ?? "";
        const ns = /using (\S+);/.exec(mk.message)?.[1] ?? NAMESPACE_OF[word];
        if ((code === "missing-using" || code === "CS0246") && ns) {
          actions.push({ title: `Add using ${ns};`, kind: "quickfix", diagnostics: [mk], isPreferred: true, edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: new monaco.Range(usingAt, 1, usingAt, 1), text: `using ${ns};\n` } }] } });
        }
        if (code === "CS1002") {
          const ln = mk.startLineNumber;
          const end = model.getLineMaxColumn(ln);
          actions.push({ title: "Add ;", kind: "quickfix", diagnostics: [mk], isPreferred: true, edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: new monaco.Range(ln, end, ln, end), text: ";" } }] } });
        }
        if ((code === "CS0103" || code === "CS1061" || code === "CS0117") && word) {
          const known = [...Object.keys(UNITY_API), ...projectTypes, ...ownMembers(text).map((x) => x.name), ...Object.values(UNITY_API).flatMap((a) => a.members.map((x) => x.name))];
          for (const k of [...new Set(known)].filter((k) => k !== word && close(k, word)).slice(0, 3)) {
            const w = model.getWordAtPosition({ lineNumber: mk.startLineNumber, column: mk.startColumn });
            if (!w) continue;
            actions.push({ title: `Change to ${k}`, kind: "quickfix", diagnostics: [mk], edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: new monaco.Range(mk.startLineNumber, w.startColumn, mk.startLineNumber, w.endColumn), text: k } }] } });
          }
        }
      }
      return { actions, dispose: () => undefined };
    },
  });
}

/** The live check's markers for a C# file (brackets, missing `using`). */
export function liveMarkers(model: monaco.editor.ITextModel): monaco.editor.IMarkerData[] {
  if (lspServes(model)) return [];
  const text = model.getValue();
  const at = (i: number) => model.getPositionAt(i);
  return [
    ...bracketProblems(text).map((p) => {
      const s = at(p.index);
      return { severity: monaco.MarkerSeverity.Error, message: p.message, startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: s.lineNumber, endColumn: s.column + 1, code: "brackets", source: "KesherAI" };
    }),
    ...missingUsings(text).map((p) => {
      const s = at(p.index);
      return { severity: monaco.MarkerSeverity.Warning, message: `${p.type} needs "using ${p.ns};" at the top (Ctrl+. adds it)`, startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: s.lineNumber, endColumn: s.column + p.type.length, code: "missing-using", source: "KesherAI" };
    }),
  ];
}
